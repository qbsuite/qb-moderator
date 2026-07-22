// Bonus cycle: the REAL app.js bonus handlers (sliced, answers.test
// style) driven by the real engine. Covers: space-stepped reveal with
// per-mode play-along defaults, checkbox/1-2-3 give-ungive toggling,
// team vs teamless attribution, and heard-tracking for ppb.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { initialState, reduce, scores, teamScores, bonusStats, liveLog } from '../engine/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../app/app.js'), 'utf8');

function slice(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error('marker not found: ' + startMarker);
  return src.slice(i, j);
}

const slices = slice('// ---------- bonus:', '// ---------- scoring panels');

// Enough DOM for the sliced handlers: elements appear on demand and
// swallow classList/innerHTML/query traffic.
const preamble = `
var stubEl = () => ({
  classList: { toggle() {}, add() {}, remove() {} },
  dataset: {}, innerHTML: '', textContent: '', value: '', checked: false,
  querySelector: () => stubEl(), querySelectorAll: () => [], blur() {},
});
var els = {};
var $ = id => els[id] || (els[id] = stubEl());
var esc = s => String(s);
var state, cur, packet, tuIdx = 0, controlling = null, review = null;
var dispatch = ev => { state = reduce(state, ev); };
var pushUndo = () => {};
var refreshQlog = () => {};
`;

function harness({ mode = 'reveal', controller = 'A1', bonusAns = 'auto' } = {}) {
  const ctx = vm.createContext({ reduce });
  vm.runInContext(preamble + slices, ctx);
  ctx.state = [
    { type: 'player_join', player: 'A1', team: 'Red' },
    { type: 'player_join', player: 'Solo' },
    { type: 'question_start', qid: 't1', powerIdx: null, unitCount: 10 },
    { type: 'buzz', player: controller, unitIdx: 3 },
    { type: 'verdict', result: 'correct' },        // +10, phase done
  ].reduce(reduce, initialState({}));
  ctx.controlling = controller;
  ctx.cur = { q: { _id: 't1' }, mode, bonus: null };
  ctx.tuIdx = 0;
  ctx.packet = { bonuses: [{ leadin: 'L', parts: ['p1', 'p2', 'p3'], answers: ['a1', 'a2', 'a3'] }] };
  ctx.$('optBonuses').checked = true;
  ctx.$('optBonusReveal').value = bonusAns;
  ctx.renderBonus();
  return ctx;
}

const bonusLog = ctx => ctx.state.log.filter(e => e.kind === 'bonus').map(
  e => ({ team: e.team, player: e.player, partIdx: e.partIdx, points: e.points }));

test('play-along (reveal mode): nothing logs until space shows an answer', () => {
  const ctx = harness({ mode: 'reveal' });
  assert.equal(bonusLog(ctx).length, 0);           // part 1 text only
  ctx.bonusStep();                                  // reveal answer 1
  assert.deepEqual(bonusLog(ctx), [{ team: 'Red', player: null, partIdx: 0, points: 0 }]);
  ctx.bonusStep();                                  // part 2 text
  assert.equal(bonusLog(ctx).length, 1);
  ctx.bonusStep();                                  // answer 2
  ctx.bonusStep(); ctx.bonusStep();                 // part 3 text + answer
  assert.equal(bonusLog(ctx).length, 3);
  ctx.bonusStep();                                  // past the end: no-op
  assert.equal(bonusLog(ctx).length, 3);
  assert.equal(bonusStats(ctx.state).teams.Red.heard, 1);
});

test('answers shown (full-text mode): each part logs as it appears', () => {
  const ctx = harness({ mode: 'text' });
  assert.equal(bonusLog(ctx).length, 1);            // part 1 + answer at build
  ctx.bonusStep();
  assert.equal(bonusLog(ctx).length, 2);
});

test('the setting overrides the mode default both ways', () => {
  const shown = harness({ mode: 'reveal', bonusAns: 'shown' });
  assert.equal(shown.cur.bonus.playalong, false);
  const hidden = harness({ mode: 'text', bonusAns: 'hidden' });
  assert.equal(hidden.cur.bonus.playalong, true);
});

test('toggling gives and ungives team points; player score untouched', () => {
  const ctx = harness({ mode: 'text' });
  ctx.bonusToggle(0, true);
  assert.equal(teamScores(ctx.state).Red, 20);      // 10 tossup + 10 bonus
  assert.equal(scores(ctx.state).A1, 10);           // tossup only
  ctx.bonusToggle(0, false);
  assert.equal(teamScores(ctx.state).Red, 10);
  ctx.bonusToggle(0, true);
  assert.equal(teamScores(ctx.state).Red, 20);
  assert.equal(bonusStats(ctx.state).teams.Red.heard, 1);
});

test('a part not yet on screen cannot be toggled', () => {
  const ctx = harness({ mode: 'reveal' });          // only part 1 shown
  const before = ctx.state.log.length;
  ctx.bonusToggle(2, true);
  assert.equal(ctx.state.log.length, before);
});

test('a teamless controller gets the bonus individually', () => {
  const ctx = harness({ mode: 'text', controller: 'Solo' });
  ctx.bonusToggle(0, true);
  assert.deepEqual(bonusLog(ctx).at(-1), { team: null, player: 'Solo', partIdx: 0, points: 10 });
  assert.equal(scores(ctx.state).Solo, 20);         // 10 tossup + 10 bonus
  assert.equal(bonusStats(ctx.state).players.Solo.ppb, 10);
});

// ---- qlog bonus attachment (players' Past Questions) ----
// Heard bonuses ship their text with the qlog entry; unheard ones stay
// off the wire (spoiler gate) until scored late from review.

const qlogSlices = slice('function summarize', 'async function nextQuestion');
const qlogPreamble = `
var state, cur, qidMeta = {}, qlog = [], room = null;
`;
const json = o => JSON.parse(JSON.stringify(o));
const BONUS_META = { leadin: 'L', parts: ['p1', 'p2', 'p3'], answers: ['a1', 'a2', 'a3'] };

function qlogHarness({ heard }) {
  const ctx = vm.createContext({ reduce, liveLog });
  vm.runInContext(qlogPreamble + qlogSlices, ctx);
  let s = [
    { type: 'player_join', player: 'A1', team: 'Red' },
    { type: 'question_start', qid: 't1', powerIdx: null, unitCount: 10 },
    { type: 'buzz', player: 'A1', unitIdx: 3 },
    { type: 'verdict', result: 'correct' },
  ].reduce(reduce, initialState({}));
  if (heard) s = reduce(s, { type: 'bonus_part', qid: 't1', partIdx: 0, team: 'Red', points: 0 });
  ctx.state = s;
  ctx.cur = { q: { _id: 't1', question_sanitized: 'Q?', answer: 'A' } };
  ctx.qidMeta = { t1: { label: 'Packet 1 · Tossup 1', bonus: BONUS_META } };
  return ctx;
}

test('a heard bonus ships with the qlog entry; an unheard one stays off', () => {
  const heard = qlogHarness({ heard: true });
  heard.logQuestion();
  assert.deepEqual(json(heard.qlog[0].bonus), BONUS_META);
  const unheard = qlogHarness({ heard: false });
  unheard.logQuestion();
  assert.equal(unheard.qlog[0].bonus, undefined);
  assert.ok(!('bonus' in json(unheard.qlog[0])), 'no bonus field on the wire');
});

test('refreshQlog attaches the bonus once review scores it late', () => {
  const ctx = qlogHarness({ heard: false });
  ctx.logQuestion();
  ctx.state = reduce(ctx.state, { type: 'bonus_part', qid: 't1', partIdx: 0, team: 'Red', points: 10 });
  ctx.refreshQlog('t1');
  assert.deepEqual(json(ctx.qlog[0].bonus), BONUS_META);
  assert.equal(ctx.qlog[0].summary, 'A1 +10 · Red bonus +10');
});

// Undo by event replay: the REAL app.js undo machinery (sliced,
// answers.test style) driven by the real engine. Covers: undoing a
// verdict, roster/settings events surviving an undo that removes the
// scoring events around them, multi-level undo, app-side snapshot
// restore (cur/bonus progress isolation), and qlog retraction.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { initialState, reduce, scores, teamScores } from '../engine/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../app/app.js'), 'utf8');

function slice(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error('marker not found: ' + startMarker);
  return src.slice(i, j);
}

const slices = slice('// ---------- undo', '// ---------- room mode');

const preamble = `
var state, cur = null, packet = null, tuIdx = 0, review = null;
var controlling = null, selPlayer = null, pendingBuzz = null;
var earlyAnswer = null, roomArmed = null, room = null;
var qlog = [];
var player = { el: { src: '', currentTime: 0 }, pause() {}, load() {} };
var stubEl = () => ({ classList: { toggle() {}, add() {}, remove() {} }, dataset: {} });
var els = {};
var $ = id => els[id] || (els[id] = stubEl());
var render = () => {};
var stopClocks = () => {};
var summarize = () => 'refreshed';
var voiceRate = () => 1;
var degradeToReveal = () => {};
`;

function harness() {
  const ctx = vm.createContext({ reduce, initialState });
  vm.runInContext(preamble + slices, ctx);
  ctx.state = initialState({});
  ctx.apply({ type: 'player_join', player: 'A', team: 'Red' });
  ctx.apply({ type: 'player_join', player: 'B', team: 'Blue' });
  ctx.apply({ type: 'question_start', qid: 'q1', powerIdx: null, unitCount: 40 });
  return ctx;
}

test('undo reverts the last action to the marked state', () => {
  const ctx = harness();
  ctx.pushUndo();
  ctx.apply({ type: 'buzz', player: 'A', unitIdx: 5 });
  ctx.apply({ type: 'verdict', result: 'correct' });
  assert.equal(scores(ctx.state).A, 10);
  assert.equal(ctx.state.phase, 'done');
  ctx.undo();
  assert.equal(scores(ctx.state).A, 0);
  assert.equal(ctx.state.phase, 'reading');
  ctx.undo();   // empty stack: no-op
  assert.equal(ctx.state.phase, 'reading');
});

test('roster and settings events after the mark survive the undo', () => {
  const ctx = harness();
  ctx.pushUndo();
  ctx.apply({ type: 'buzz', player: 'A', unitIdx: 5 });
  ctx.apply({ type: 'player_join', player: 'Late', team: 'Blue' });
  ctx.apply({ type: 'verdict', result: 'correct' });
  ctx.apply({ type: 'configure', patch: { points: { superpower: 20 } } });
  ctx.undo();
  assert.ok(ctx.state.players.includes('Late'));
  assert.equal(ctx.state.config.points.superpower, 20);
  assert.equal(scores(ctx.state).A, 0);
});

test('multi-level undo pops actions in order', () => {
  const ctx = harness();
  ctx.pushUndo();
  ctx.apply({ type: 'buzz', player: 'A', unitIdx: 5 });
  ctx.apply({ type: 'verdict', result: 'wrong' });          // -5 + lockout
  ctx.pushUndo();
  ctx.apply({ type: 'buzz', player: 'B', unitIdx: 8 });
  ctx.apply({ type: 'verdict', result: 'correct' });
  assert.deepEqual(teamScores(ctx.state), { Red: -5, Blue: 10 });
  ctx.undo();
  assert.deepEqual(teamScores(ctx.state), { Red: -5, Blue: 0 });
  assert.deepEqual(ctx.state.current.lockouts, ['A']);
  ctx.undo();
  assert.deepEqual(teamScores(ctx.state), { Red: 0, Blue: 0 });
  assert.deepEqual(ctx.state.current.lockouts, []);
});

test('app-side snapshot restores cur, and bonus progress is isolated', () => {
  const ctx = harness();
  ctx.cur = { q: { _id: 'q1' }, mode: 'reveal', unitIdx: 7, pending: false,
              bonus: { for: 0, n: 3, shown: 2, revealed: 1,
                       given: [true, false, false], logged: [true, false, false] } };
  ctx.tuIdx = 3;
  ctx.pushUndo();
  ctx.cur.bonus.given[1] = true;          // later mutation in place
  ctx.cur.bonus.shown = 3;
  ctx.cur.unitIdx = 20;
  ctx.tuIdx = 4;
  ctx.undo();
  assert.equal(ctx.tuIdx, 3);
  assert.equal(ctx.cur.unitIdx, 7);
  assert.deepEqual([...ctx.cur.bonus.given], [true, false, false]);
  assert.equal(ctx.cur.bonus.shown, 2);
});

test('undoing past a question retracts its qlog entry and refreshes the rest', () => {
  const ctx = harness();
  ctx.qlog.push({ qid: 'q0', summary: 'old' });
  ctx.pushUndo();                          // the "next" action's mark
  ctx.qlog.push({ qid: 'q1', summary: 'old' });
  ctx.undo();
  assert.equal(ctx.qlog.length, 1);
  assert.equal(ctx.qlog[0].summary, 'refreshed');
});

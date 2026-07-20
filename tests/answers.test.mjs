// Typed-answer flow: the REAL app.js handlers (sliced, like the site's
// reader tests) driven by the real engine and the real vendored answer
// checker. Covers: remote buzz -> typed answer -> accept/reject scoring,
// the prompt -> retype loop, the early-answer stash, and the
// checker-off manual path. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { initialState, reduce, scores } from '../engine/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../app/app.js'), 'utf8');
const { checkAnswer } = createRequire(import.meta.url)('../app/vendor/answer_checker.js');

function slice(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error('marker not found: ' + startMarker);
  return src.slice(i, j);
}

// vm-realm objects have foreign prototypes; strict deepEqual would fail
const json = o => JSON.parse(JSON.stringify(o));

const slices = [
  slice('function handleRemoteBuzzPending', 'function buildSnapshot'),
  slice('function applyVerdict', '// Player-row point buttons'),
  slice('function suggested', "// ---------- controls ----------"),
].join('\n');

// `var` so everything lands on the context global and stays visible to
// the test through the contextified object.
const preamble = `
var state, cur, pendingBuzz = null, selPlayer = null, controlling = null;
var earlyAnswer = null, roomArmed = null;
var sent = [];
var room = { send: m => sent.push(m) };
var calls = { paused: 0, resumed: 0 };
var els = { givenanswer: { value: '' }, optChecker: { checked: true } };
var $ = id => els[id];
var dispatch = ev => { state = reduce(state, ev); };
var render = () => {};
var syncRoom = () => {};
var pauseReading = () => { calls.paused++; };
var resumeReading = () => { calls.resumed++; };
var posNow = () => (cur && cur.mode !== 'text' ? cur.unitIdx : null);
`;

const ANSWERLINE = '<b><u>Paris</u></b> [prompt on France by asking "the capital of what?"]';

function harness({ checker = true, unitIdx = 5, powerIdx = 10 } = {}) {
  const ctx = vm.createContext({ reduce, qbCheckAnswer: checkAnswer, Date });
  vm.runInContext(preamble + slices, ctx);
  ctx.state = reduce(reduce(reduce(initialState({}),
    { type: 'player_join', player: 'Kim' }),
    { type: 'player_join', player: 'Sam' }),
    { type: 'question_start', qid: 'q1', powerIdx, unitCount: 40 });
  ctx.cur = { q: { _id: 'q1', answer: ANSWERLINE }, mode: 'reveal', unitIdx };
  ctx.els.optChecker.checked = checker;
  return ctx;
}

// sanity: the answerline behaves as the vectors below assume
test('checker vectors for the test answerline', () => {
  assert.equal(checkAnswer(ANSWERLINE, 'Paris').directive, 'accept');
  const p = checkAnswer(ANSWERLINE, 'France');
  assert.equal(p.directive, 'prompt');
  assert.equal(p.directedPrompt, 'the capital of what?');
  assert.equal(checkAnswer(ANSWERLINE, 'London').directive, 'reject');
});

test('typed accept scores the buzz and reports correct', () => {
  const ctx = harness({ unitIdx: 5 });   // before the power mark
  ctx.handleRemoteBuzzPending('Kim');
  ctx.handleRemoteBuzz('Kim');
  ctx.handleRemoteAnswer('Kim', 'Paris');
  assert.equal(ctx.state.phase, 'done');
  assert.equal(scores(ctx.state).Kim, 15);
  assert.equal(ctx.state.log[0].source, 'checker');
  assert.equal(ctx.state.log[0].answer, 'Paris');
  assert.equal(ctx.pendingBuzz, null);
  assert.deepEqual(json(ctx.sent.at(-1)), { t: 'answer_result', name: 'Kim', result: 'correct' });
});

test('typed reject negs, locks out, and reports wrong', () => {
  const ctx = harness();
  ctx.handleRemoteBuzzPending('Kim');
  ctx.handleRemoteBuzz('Kim');
  ctx.handleRemoteAnswer('Kim', 'London');
  assert.equal(ctx.state.phase, 'reading');
  assert.equal(scores(ctx.state).Kim, -5);
  assert.ok(ctx.state.current.lockouts.includes('Kim'));
  assert.deepEqual(json(ctx.sent.at(-1)), { t: 'answer_result', name: 'Kim', result: 'wrong' });
  assert.equal(ctx.calls.resumed, 1);
});

test('prompt keeps the buzz open; the retype scores', () => {
  const ctx = harness();
  ctx.handleRemoteBuzzPending('Kim');
  ctx.handleRemoteBuzz('Kim');
  ctx.handleRemoteAnswer('Kim', 'France');
  assert.deepEqual(json(ctx.sent.at(-1)),
    { t: 'answer_result', name: 'Kim', result: 'prompt', prompt: 'the capital of what?' });
  assert.ok(ctx.pendingBuzz, 'buzz stays pending through a prompt');
  assert.equal(ctx.state.phase, 'reading');   // engine untouched so far
  ctx.handleRemoteAnswer('Kim', 'Paris');
  assert.equal(ctx.state.phase, 'done');
  assert.equal(scores(ctx.state).Kim, 15);
});

test('an answer that outruns the buzz window applies after resolution', () => {
  const ctx = harness();
  ctx.handleRemoteBuzzPending('Kim');
  ctx.handleRemoteAnswer('Kim', 'Paris');    // window still open
  assert.equal(ctx.state.phase, 'reading', 'stashed, not applied');
  ctx.handleRemoteBuzz('Kim');
  assert.equal(ctx.state.phase, 'done');
  assert.equal(scores(ctx.state).Kim, 15);
});

test('a stashed answer from a losing buzzer is dropped', () => {
  const ctx = harness();
  ctx.handleRemoteBuzzPending('Kim');
  ctx.handleRemoteAnswer('Kim', 'Paris');
  ctx.handleRemoteBuzz('Sam');               // equalized winner differs
  assert.equal(ctx.state.phase, 'reading');
  assert.equal(ctx.selPlayer, 'Sam');
  assert.equal(ctx.earlyAnswer, null);
});

test('remote buzzes are ignored before Start (ready gate)', () => {
  const ctx = harness();
  ctx.cur.pending = true;
  ctx.handleRemoteBuzzPending('Kim');
  assert.equal(ctx.pendingBuzz, null);
  assert.equal(ctx.selPlayer, null);
  ctx.handleRemoteBuzz('Kim');
  assert.equal(ctx.pendingBuzz, null);
  assert.equal(ctx.calls.paused, 0);
});

test('answers from a non-buzzer are ignored', () => {
  const ctx = harness();
  ctx.handleRemoteBuzzPending('Kim');
  ctx.handleRemoteBuzz('Kim');
  ctx.handleRemoteAnswer('Sam', 'Paris');
  assert.equal(ctx.state.phase, 'reading');
  assert.equal(ctx.sent.length, 0);
});

test('checker off: the answer fills the host field, no auto verdict', () => {
  const ctx = harness({ checker: false });
  ctx.handleRemoteBuzzPending('Kim');
  ctx.handleRemoteBuzz('Kim');
  ctx.handleRemoteAnswer('Kim', 'Paris');
  assert.equal(ctx.state.phase, 'reading');
  assert.equal(ctx.els.givenanswer.value, 'Paris');
  assert.equal(ctx.sent.length, 0);
  // the host's ✓ still closes the loop for the player
  ctx.applyVerdict('correct');
  assert.equal(ctx.state.phase, 'done');
  assert.deepEqual(json(ctx.sent.at(-1)), { t: 'answer_result', name: 'Kim', result: 'correct' });
});

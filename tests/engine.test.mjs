// Engine rule-table vectors. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, scores, defaultConfig } from '../engine/engine.js';

const play = (state, ...events) => events.reduce(reduce, state);

function start(config, { powerIdx = 10, superpowerIdx = null } = {}) {
  let s = initialState(config);
  s = play(s,
    { type: 'player_join', player: 'A' },
    { type: 'player_join', player: 'B' },
    { type: 'question_start', qid: 'q1', powerIdx, superpowerIdx, unitCount: 40 });
  return s;
}

test('correct before the power mark scores 15', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 9 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 15);
  assert.equal(s.log[0].kind, 'power');
  assert.equal(s.phase, 'done');
});

test('buzz exactly at the power mark unit is a get (strict <)', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 10 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 10);
  assert.equal(s.log[0].kind, 'get');
});

test('no power mark -> always a 10', () => {
  let s = start({}, { powerIdx: null });
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 0 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 10);
});

test('superpower when enabled', () => {
  let s = start({ points: { superpower: 20 } }, { powerIdx: 10, superpowerIdx: 5 });
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 4 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 20);
  assert.equal(s.log[0].kind, 'superpower');
  assert.deepEqual(defaultConfig({ points: { superpower: 20 } }).pointPad,
    [15, 10, -5, 20]);
});

test('wrong during reading is a -5 neg + lockout, reading resumes', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(scores(s).A, -5);
  assert.equal(s.log[0].kind, 'neg');
  assert.equal(s.phase, 'reading');            // resume for others
  assert.deepEqual(s.current.lockouts, ['A']);
  // A cannot buzz again; B can.
  const blocked = reduce(s, { type: 'buzz', player: 'A', unitIdx: 12 });
  assert.equal(blocked.phase, 'reading');
  s = play(s,
    { type: 'buzz', player: 'B', unitIdx: 12 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).B, 10);
});

test('wrong after reading finished is 0, not a neg', () => {
  let s = start();
  s = play(s,
    { type: 'reading_finished' },
    { type: 'buzz', player: 'A', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(scores(s).A, 0);
  assert.equal(s.log[0].kind, 'miss');
});

test('all players locked out after reading finished -> question dead', () => {
  let s = start();
  s = play(s,
    { type: 'reading_finished' },
    { type: 'buzz', player: 'A', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' },
    { type: 'buzz', player: 'B', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(s.phase, 'done');
});

test('lockouts do not end the question while reading continues', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' },
    { type: 'buzz', player: 'B', unitIdx: 6 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(s.phase, 'reading');            // dead only via reading_finished/dead
  assert.equal(scores(s).A + scores(s).B, -10);
});

test('scoreless mode keeps flow but logs 0 points', () => {
  let s = start({ scoring: false });
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(scores(s).A, 0);
  assert.equal(s.log[0].kind, 'neg');          // history still meaningful
  s = play(s,
    { type: 'buzz', player: 'B', unitIdx: 6 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).B, 0);
});

test('verdict points override: the pad drives flow with forced points', () => {
  // Voice/manual-read mode: position unknown, host taps +15 -> correct
  // with 15 regardless of unitIdx; -5 -> wrong+lockout with -5 even if
  // the rule table would say 0.
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 30 },       // after the mark
    { type: 'verdict', result: 'correct', points: 15 });
  assert.equal(scores(s).A, 15);
  assert.equal(s.phase, 'done');
  let t = start();
  t = play(t,
    { type: 'reading_finished' },
    { type: 'buzz', player: 'B', unitIdx: 39 },
    { type: 'verdict', result: 'wrong', points: -5 });
  assert.equal(scores(t).B, -5);
  assert.deepEqual(t.current.lockouts, ['B']);
});

test('unknown buzz position (null) is never a power', () => {
  let s = start();                                     // powerIdx 10
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: null },      // manual-read mode
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 10);
  assert.equal(s.log[0].kind, 'get');
});

test('award: the host point pad writes direct score lines', () => {
  let s = start();
  s = play(s,
    { type: 'award', player: 'A', points: 15, reason: 'pad' },
    { type: 'award', player: 'A', points: -5, reason: 'pad' },
    { type: 'award', player: 'B', points: 10, reason: 'bonus' });
  assert.equal(scores(s).A, 10);
  assert.equal(scores(s).B, 10);
});

test('override edits a past line and totals recompute', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 15);
  s = reduce(s, { type: 'override', entryIdx: 0, points: 10 });
  assert.equal(scores(s).A, 10);
  assert.equal(s.log[0].overridden, true);
});

test('impossible transitions are ignored', () => {
  let s = start();
  assert.equal(reduce(s, { type: 'verdict', result: 'correct' }), s); // no buzz yet
  s = reduce(s, { type: 'buzz', player: 'A', unitIdx: 5 });
  assert.equal(reduce(s, { type: 'buzz', player: 'B', unitIdx: 6 }).current.buzz.player, 'A');
  assert.equal(reduce(s, { type: 'next' }).phase, 'buzzed'); // next only from done
});

test('dead + next cycle', () => {
  let s = start();
  s = play(s, { type: 'dead' }, { type: 'next' });
  assert.equal(s.phase, 'idle');
  assert.equal(s.current, null);
});

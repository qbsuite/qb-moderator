// Sidecar audio-clock -> unit-index mapper vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMapper } from '../app/audio.js';
import { questionUnits } from '../app/vendor/reveal_units.js';

// 3 chunks: 4 + 6 + 2 = 12 words; spans with a 0.5 s silence gap
// between chunk 1 and 2.
const SIDECAR = {
  v: 1,
  chunks: [[0.0, 2.0], [2.5, 5.5], [5.5, 6.5]],
  texts: ['one two three four', 'five six seven eight nine ten', 'eleven twelve'],
};

test('sidecar mapper interpolates within chunks', () => {
  const m = makeMapper(SIDECAR, 12);   // unitCount == word count: identity scale
  assert.equal(m(0), 0);
  assert.equal(m(1.0), 2);             // halfway through chunk 0 -> 2 of 4 words
  assert.equal(m(4.0), 7);             // chunk 1 at frac 0.5 -> 4 + 3
  assert.equal(m(6.5), 12);            // end
});

test('silence gaps hold at the previous chunk boundary', () => {
  const m = makeMapper(SIDECAR, 12);
  assert.equal(m(2.2), 4);             // between chunks: end of chunk 0
});

test('past the last chunk clamps to the end', () => {
  const m = makeMapper(SIDECAR, 12);
  assert.equal(m(99), 12);
});

test('unit count scaling (cleaned text shorter than raw units)', () => {
  const m = makeMapper(SIDECAR, 24);   // raw question has 24 units
  assert.equal(m(1.0), 4);             // 2/12 words -> 4/24 units
});

test('no sidecar -> proportional fallback on duration', () => {
  const m = makeMapper(null, 100);
  assert.equal(m(5, 10), 50);
  assert.equal(m(0, NaN), 0);          // metadata not loaded yet
});

test('questionUnits finds power and superpower marks', () => {
  const { units, powerIdx, superpowerIdx } =
    questionUnits('Alpha beta (+) gamma delta (*) epsilon zeta.');
  assert.equal(units[superpowerIdx].t, '(+)');
  assert.equal(units[powerIdx].t, '(*)');
  assert.equal(superpowerIdx, 2);
  assert.equal(powerIdx, 5);
  const plain = questionUnits('No marks here at all.');
  assert.equal(plain.powerIdx, null);
  assert.equal(plain.superpowerIdx, null);
});

test('note runs split into per-note units (reveal contract)', () => {
  const { units } = questionUnits('opens with E–F♯–G–E in the violins');
  const texts = units.map(u => u.t);
  assert.ok(texts.includes('E–'));
  assert.ok(texts.length > 7);         // the dash run split
});

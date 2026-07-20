// Tests for app/sync.js — the pure clock-offset / scheduled-playback
// math behind the audio broadcast protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../app/sync.js';   // classic script: attaches the global

const { sampleFromExchange, bestOffset, playDelay, lateSeek, anchorTarget, gateResolved } =
  globalThis.qbSync;

test('sampleFromExchange recovers the offset exactly on a symmetric path', () => {
  // Server clock leads local by 5000ms; 40ms each way.
  const c = 100000;                 // local send
  const s = 100040 + 5000;          // server stamp at arrival
  const r = 100080;                 // local receipt
  const { rtt, offset } = sampleFromExchange(c, s, r);
  assert.equal(rtt, 80);
  assert.equal(offset, 5000);
});

test('sampleFromExchange error on an asymmetric path is bounded by rtt/2', () => {
  // True offset 0; 70ms out, 10ms back (rtt 80, asymmetry 30).
  const c = 100000;
  const s = 100070;
  const r = 100080;
  const { rtt, offset } = sampleFromExchange(c, s, r);
  assert.equal(rtt, 80);
  assert.ok(Math.abs(offset) <= rtt / 2);
  assert.equal(offset, 30);
});

test('bestOffset picks the minimum-RTT sample', () => {
  const samples = [
    { rtt: 120, offset: 900 },
    { rtt: 35, offset: 1010 },
    { rtt: 80, offset: 950 },
  ];
  assert.equal(bestOffset(samples), 1010);
});

test('bestOffset is null with no samples', () => {
  assert.equal(bestOffset([]), null);
});

test('playDelay is positive before the scheduled instant', () => {
  // Server says start at 5300; server leads local by 1000; local now 4100.
  // Local start instant = 5300 - 1000 = 4300 → 200ms away.
  assert.equal(playDelay(5300, 1000, 4100), 200);
});

test('playDelay is negative after the scheduled instant', () => {
  assert.equal(playDelay(5300, 1000, 4500), -200);
});

test('lateSeek scales the missed wall time by playbackRate', () => {
  assert.equal(lateSeek(0, 500, 1), 0.5);
  assert.equal(lateSeek(2, 1000, 1.5), 3.5);
  assert.equal(lateSeek(1, 0, 2), 1);
});

test('anchorTarget returns pos verbatim when paused', () => {
  assert.equal(anchorTarget({ pos: 12.5, sv: 9000, rate: 2, playing: false }, 0, 99999), 12.5);
});

test('anchorTarget adds rate-scaled elapsed server time when playing', () => {
  // Relayed at server 9000; local now 8500 with offset 1000 → server now
  // 9500 → 500ms elapsed at rate 2 → +1s of audio.
  const t = anchorTarget({ pos: 10, sv: 9000, rate: 2, playing: true }, 1000, 8500);
  assert.equal(t, 11);
});

test('anchorTarget clamps negative elapsed (clock skew) to zero', () => {
  const t = anchorTarget({ pos: 10, sv: 9000, rate: 1, playing: true }, 0, 8000);
  assert.equal(t, 10);
});

test('gateResolved: all players resolved', () => {
  const resolved = new Set(['ann', 'bob']);
  assert.equal(gateResolved(['ann', 'bob'], resolved, 5000, 1000), true);
});

test('gateResolved: waiting on a player before the deadline', () => {
  const resolved = new Set(['ann']);
  assert.equal(gateResolved(['ann', 'bob'], resolved, 5000, 1000), false);
});

test('gateResolved: deadline expiry overrides missing players', () => {
  assert.equal(gateResolved(['ann', 'bob'], new Set(), 5000, 5000), true);
});

test('gateResolved: empty room resolves immediately', () => {
  assert.equal(gateResolved([], new Set(), 5000, 0), true);
});

// Session persistence: the REAL app.js save/load/resume machinery
// (sliced, answers.test style) driven by the real engine. A "refresh"
// is two vm contexts sharing one localStorage object: context 1 plays
// and saves, context 2 loads and resumes — scores, packet position,
// the live question, and a pending buzz must all survive the replay.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { initialState, reduce, scores } from '../engine/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../app/app.js'), 'utf8');

function slice(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error('marker not found: ' + startMarker);
  return src.slice(i, j);
}

const slices = slice('// ---------- session persistence', '// ---------- rendering');

const json = o => JSON.parse(JSON.stringify(o));

const preamble = `
var SET = null, setSlug = null, packet = null, packetIdx = -1;
var tuIdx = -1, packetLabel = '';
var state, cur = null, pendingBuzz = null, selPlayer = null, controlling = null;
var room = null, events = [], teamList = [], qlog = [];
var qidMeta = {};
var player = { el: { currentTime: 0, playbackRate: 1, addEventListener() {} },
               load() {}, pause() {} };
var els = { modepick: { value: 'reveal' }, modepick2: { value: '' },
            optScoring: { checked: false }, optSuper: { checked: false },
            setsheet: { classList: { remove() {} } } };
var $ = id => els[id];
var render = () => {};
var renderPacketDone = () => {};
var voiceRate = () => 1;
var degradeToReveal = () => {};
var attachAudioHandlers = () => {};
var hostedWith = null;
var hostRoom = (code, server) => { hostedWith = { code, server }; };
var questionUnits = t => ({
  units: String(t).split(/\\s+/).map((w, i) => ({ t: w, sep: i > 0 })),
  powerIdx: null, superpowerIdx: null });
var slowSpans = () => new Set();
var audio = { positionMapper: async () => (() => 0) };
`;

function makeCtx(store) {
  const ctx = vm.createContext({ reduce, initialState, Date, localStorage: store, fetch });
  vm.runInContext(preamble + slices, ctx);
  ctx.state = initialState({});
  return ctx;
}

const Q1 = { _id: 'q1', question_sanitized: 'First question text here', answer: 'A1' };
const Q2 = { _id: 'q2', question_sanitized: 'Second question', answer: 'A2' };
const PACKET_SET = { name: 'Test Set', packets: [{ number: 1, tossups: [Q1, Q2], bonuses: [] }] };

function play(ctx, ...evs) {
  for (const ev of evs) { ctx.events.push(ev); ctx.state = reduce(ctx.state, ev); }
}

test('save -> fresh context -> resume: scores, position, live question, pending buzz', async () => {
  const store = {};
  const c1 = makeCtx(store);
  c1.SET = PACKET_SET; c1.setSlug = null; c1.packetIdx = 0;
  c1.packet = PACKET_SET.packets[0]; c1.packetLabel = 'Packet 1'; c1.tuIdx = 0;
  c1.teamList = ['Red'];
  c1.qidMeta = { q1: { label: 'Packet 1 · Tossup 1' } };
  c1.qlog = [];
  play(c1,
    { type: 'player_join', player: 'Kim', team: 'Red' },
    { type: 'player_join', player: 'Sam', team: null },
    { type: 'question_start', qid: 'q1', powerIdx: null, unitCount: 4 },
    { type: 'buzz', player: 'Sam', unitIdx: 2 },
    { type: 'verdict', result: 'wrong' });          // Sam -5, locked out
  c1.cur = { q: Q1, mode: 'reveal', pending: false, degraded: false, noAudio: false,
             unitIdx: 3, bonus: null };
  c1.pendingBuzz = { unitIdx: 3, ts: 111, tentative: true };  // Kim's buzz, mid-adjudication
  c1.selPlayer = 'Kim';
  c1.room = { code: 'ABCD', server: 'https://example.test' };
  c1.saveSession();

  const c2 = makeCtx(store);   // the refresh: everything in-memory is gone
  const s = c2.loadSession();
  assert.ok(s, 'session survives');
  assert.match(s.title, /Test Set · Packet 1 · TU 1\/2/);
  await c2.resumeSession(s);

  assert.equal(json(scores(c2.state)).Sam, -5);
  assert.deepEqual(json(c2.state.current.lockouts), ['Sam']);
  assert.equal(c2.state.phase, 'reading');
  assert.equal(c2.tuIdx, 0);
  assert.equal(c2.cur.q._id, 'q1');
  assert.equal(c2.cur.unitIdx, 3, 'reveal position restored');
  assert.equal(c2.cur.units.length, 4, 'units rebuilt from the packet');
  assert.equal(c2.selPlayer, 'Kim');
  assert.equal(c2.pendingBuzz.unitIdx, 3);
  assert.ok(!('tentative' in json(c2.pendingBuzz)), 'stale window flag stripped');
  assert.deepEqual(json(c2.hostedWith), { code: 'ABCD', server: 'https://example.test' },
    'room reconnected with the saved code + server');
  assert.deepEqual(json(c2.teamList), ['Red']);
});

test('no packet -> nothing saved; stale sessions are ignored', () => {
  const store = {};
  const c1 = makeCtx(store);
  c1.saveSession();
  assert.equal(store.qbmodSession, undefined);

  const c2 = makeCtx(store);
  store.qbmodSession = JSON.stringify({ v: 1, ts: Date.now() - 13 * 3600 * 1000, title: 'old' });
  assert.equal(c2.loadSession(), null, 'past the 12h TTL');
  store.qbmodSession = '{broken';
  assert.equal(c2.loadSession(), null, 'corrupt JSON tolerated');
});

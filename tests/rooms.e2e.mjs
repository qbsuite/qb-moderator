// Live E2E for the room server protocol (needs a deployed instance —
// not part of CI). Run: node tests/rooms.e2e.mjs [server-url]
const SERVER = process.argv[2] || 'https://qb-rooms.denisliu10.workers.dev';
const WS = SERVER.replace('http', 'ws');

const fail = msg => { console.error('FAIL:', msg); process.exit(1); };
const ok = msg => console.log('  ok ', msg);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(code, name, role, pongDelay = 0) {
  const ws = new WebSocket(`${WS}/rooms/${code}/ws?name=${name}&role=${role}`);
  const queue = [];
  const waiters = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'ping') {
      // Echo RTT probes like the player page does; pongDelay fakes a
      // high-latency connection for the equalization test.
      const reply = () => { try { ws.send(JSON.stringify({ t: 'pong', n: m.n, ts: m.ts })); } catch (err) {} };
      pongDelay ? setTimeout(reply, pongDelay) : reply();
      return;
    }
    const i = waiters.findIndex(w => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  };
  ws.next = (pred, why, ms = 5000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: ' + why)), ms);
      waiters.push({ pred, resolve: m => { clearTimeout(timer); resolve(m); } });
    });
  };
  ws.sendJson = o => ws.send(JSON.stringify(o));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = e => reject(new Error('ws error connecting ' + name));
  });
}

const { code } = await (await fetch(SERVER + '/rooms', { method: 'POST' })).json();
if (!/^[A-Z2-9]{4}$/.test(code)) fail('bad room code: ' + code);
ok('room created: ' + code);

const host = await connect(code, 'Host', 'host');
await host.next(m => m.t === 'welcome', 'host welcome');
const p1 = await connect(code, 'Kim', 'player');
const w1 = await p1.next(m => m.t === 'welcome', 'p1 welcome');
if (w1.armed !== false) fail('room should start disarmed');
await host.next(m => m.t === 'join' && m.name === 'Kim', 'host sees Kim join');
ok('join fan-out');

host.sendJson({ t: 'state', snapshot: { label: 'TU 1', scores: { Kim: 0 } } });
await p1.next(m => m.t === 'state' && m.snapshot.label === 'TU 1', 'p1 gets state');
ok('state relay');

// buzz while disarmed -> rejected
p1.sendJson({ t: 'buzz' });
await p1.next(m => m.t === 'rejected', 'disarmed buzz rejected');
ok('disarmed buzz rejected');

host.sendJson({ t: 'arm' });
await p1.next(m => m.t === 'arm', 'p1 armed');
const p2 = await connect(code, 'Sam', 'player');
await p2.next(m => m.t === 'welcome', 'p2 welcome');

// first buzz wins; second is rejected
p1.sendJson({ t: 'buzz' });
const b = await host.next(m => m.t === 'buzz', 'host receives buzz');
if (b.name !== 'Kim') fail('wrong buzzer: ' + b.name);
await p2.next(m => m.t === 'buzz' && m.name === 'Kim', 'p2 sees Kim buzzed');
p2.sendJson({ t: 'buzz' });
await p2.next(m => m.t === 'rejected', 'second buzz rejected');
ok('first-buzz arbitration');

// re-arm -> Sam can buzz
host.sendJson({ t: 'arm' });
await p2.next(m => m.t === 'arm', 'p2 re-armed');
p2.sendJson({ t: 'buzz' });
const b2 = await host.next(m => m.t === 'buzz' && m.name === 'Sam', 'Sam buzz');
ok('re-arm cycle');

// typed answer -> host relay (name attached server-side), verdict back
p2.sendJson({ t: 'answer', text: 'Douglass' });
const ans = await host.next(m => m.t === 'answer', 'host receives typed answer');
if (ans.name !== 'Sam' || ans.text !== 'Douglass') fail('bad answer relay: ' + JSON.stringify(ans));
host.sendJson({ t: 'answer_result', name: 'Sam', result: 'prompt', prompt: 'which one?' });
const ar = await p2.next(m => m.t === 'answer_result', 'p2 gets prompt');
if (ar.name !== 'Sam' || ar.result !== 'prompt' || ar.prompt !== 'which one?') fail('bad answer_result: ' + JSON.stringify(ar));
p2.sendJson({ t: 'answer', text: 'Frederick Douglass' });
await host.next(m => m.t === 'answer' && m.text === 'Frederick Douglass', 'host receives re-answer');
host.sendJson({ t: 'answer_result', name: 'Sam', result: 'correct' });
await p2.next(m => m.t === 'answer_result' && m.result === 'correct', 'p2 gets verdict');
ok('typed answer relay + prompt round-trip');

// question log relay
host.sendJson({ t: 'qlog', qlog: [{ label: 'TU 1', question: 'Who?', answer: 'X', summary: 'Kim +10' }] });
await p2.next(m => m.t === 'qlog' && m.qlog.length === 1, 'p2 gets qlog');
ok('qlog relay');

// --- audio broadcast (v1.1) ---
// sync round-trip: server echoes {c, s} immediately, s is server now
const c0 = Date.now();
host.sendJson({ t: 'sync', c: c0 });
const hs = await host.next(m => m.t === 'sync', 'host sync echo');
if (hs.c !== c0 || typeof hs.s !== 'number') fail('bad host sync echo: ' + JSON.stringify(hs));
p2.sendJson({ t: 'sync', c: 123 });
const ps = await p2.next(m => m.t === 'sync', 'player sync echo');
if (ps.c !== 123 || typeof ps.s !== 'number') fail('bad player sync echo: ' + JSON.stringify(ps));
ok('sync round-trip (host + player)');

// manifest: stored + broadcast to players
host.sendJson({ t: 'audio_manifest', entries: [{ qid: 'q1', url: 'https://cdn/q1.opus' }] });
const man = await p2.next(m => m.t === 'audio_manifest', 'p2 gets manifest');
if (man.entries?.[0]?.qid !== 'q1') fail('bad manifest relay: ' + JSON.stringify(man));
ok('audio_manifest relay');

// player readiness relays to the host with the name attached
p2.sendJson({ t: 'audio_ready', qid: 'q1' });
const rdy = await host.next(m => m.t === 'audio_ready', 'host gets audio_ready');
if (rdy.name !== 'Sam' || rdy.qid !== 'q1') fail('bad audio_ready relay: ' + JSON.stringify(rdy));
ok('audio_ready relay');

// scheduled start: stamped sv + at (= sv + 300) and echoed to EVERYONE,
// the sending host included
host.sendJson({ t: 'audio_start', qid: 'q1', pos: 0, rate: 1 });
const [se, pe] = await Promise.all([
  host.next(m => m.t === 'audio_start', 'host gets its own audio_start echo'),
  p2.next(m => m.t === 'audio_start', 'p2 gets audio_start'),
]);
if (se.at - se.sv !== 300) fail('bad start stamping: ' + JSON.stringify(se));
if (pe.at !== se.at) fail('host and player got different start instants');
ok('audio_start scheduled + echoed to sender (at = sv + 300)');

// plain anchors relay to players (not back to the sender)
host.sendJson({ t: 'audio_pause', qid: 'q1', pos: 3.2 });
const pp = await p2.next(m => m.t === 'audio_pause', 'p2 gets audio_pause');
if (pp.pos !== 3.2 || typeof pp.sv !== 'number') fail('bad audio_pause relay: ' + JSON.stringify(pp));
ok('audio_pause relay (sv-stamped)');

// audio_resync relays to hosts with the name
p2.sendJson({ t: 'audio_resync' });
const rs = await host.next(m => m.t === 'audio_resync', 'host gets audio_resync');
if (rs.name !== 'Sam') fail('bad audio_resync relay: ' + JSON.stringify(rs));
ok('audio_resync relay');

// late joiner gets the stored snapshot + roster + qlog + audio manifest
const late = await connect(code, 'Late', 'player');
const wl = await late.next(m => m.t === 'welcome', 'late welcome');
if (wl.snapshot?.label !== 'TU 1') fail('late joiner missing snapshot');
if (!wl.roster.some(r => r.name === 'Host' && r.role === 'host')) fail('roster missing host');
if (!(wl.qlog && wl.qlog.length === 1 && wl.qlog[0].label === 'TU 1')) fail('late joiner missing qlog');
if (wl.audioManifest?.[0]?.qid !== 'q1') fail('late joiner missing audio manifest');
ok('late-join snapshot + roster + qlog + audio manifest');

// leave fan-out
p1.close();
await host.next(m => m.t === 'leave' && m.name === 'Kim', 'leave fan-out');
ok('leave fan-out');

// --- latency-equalized arbitration ---
// 'Slow' fakes ~190ms of extra RTT by delaying its pongs; after a few
// arm cycles (pings ride each arm) its buzzes get ~100ms (capped)
// backdating. It then buzzes 25ms AFTER 'Fast' and must still win —
// estimated press time, not arrival, decides the race. (25ms, not more:
// the win margin is comp_slow − comp_fast − gap ≈ 100 − rtt/2 − 25, and
// live-network send jitter has to fit inside it.)
const { code: code2 } = await (await fetch(SERVER + '/rooms', { method: 'POST' })).json();
const host2 = await connect(code2, 'Host2', 'host');
await host2.next(m => m.t === 'welcome', 'host2 welcome');
const fast = await connect(code2, 'Fast', 'player');
await fast.next(m => m.t === 'welcome', 'fast welcome');
const slow = await connect(code2, 'Slow', 'player', 190);
await slow.next(m => m.t === 'welcome', 'slow welcome');
for (let i = 0; i < 3; i++) {
  host2.sendJson({ t: 'arm' });
  await fast.next(m => m.t === 'arm', 'sample arm fast ' + i);
  await slow.next(m => m.t === 'arm', 'sample arm slow ' + i);
  host2.sendJson({ t: 'disarm' });
  await fast.next(m => m.t === 'disarm', 'sample disarm fast ' + i);
  await slow.next(m => m.t === 'disarm', 'sample disarm slow ' + i);
  await sleep(250); // let Slow's delayed pongs land
}
// The race margin (~comp_slow − comp_fast − 25ms) has to absorb live-
// network send jitter, so a single run can flake; a real equalization
// regression loses every attempt.
let winName = null;
for (let attempt = 1; attempt <= 3 && winName !== 'Slow'; attempt++) {
  host2.sendJson({ t: 'arm' });
  await fast.next(m => m.t === 'arm', 'race arm fast #' + attempt);
  await slow.next(m => m.t === 'arm', 'race arm slow #' + attempt);
  fast.sendJson({ t: 'buzz' });
  // The host must hear about the FIRST arrival immediately (stop-reading
  // cue), before the arbitration window resolves.
  await host2.next(m => m.t === 'buzz_pending' && m.name === 'Fast', 'immediate pending notification #' + attempt);
  if (attempt === 1) {
    ok('host notified of first arrival before the window resolves');
    // buzz_pending is broadcast (v1.1): phones pause audio on it too.
    await slow.next(m => m.t === 'buzz_pending' && m.name === 'Fast', 'player also gets buzz_pending');
    ok('players get buzz_pending (fast audio pause)');
  }
  await sleep(25);
  slow.sendJson({ t: 'buzz' });
  const win = await host2.next(m => m.t === 'buzz', 'equalized winner #' + attempt, 8000);
  winName = win.name;
  if (winName !== 'Slow') console.log('  (attempt ' + attempt + ': ' + winName + ' won — jitter, retrying)');
}
if (winName !== 'Slow') fail('latency equalization: Slow never won in 3 attempts');
await fast.next(m => m.t === 'rejected', 'fast told it lost the window');
ok('latency-equalized arbitration (high-RTT player wins a 25ms-later buzz)');
fast.close(); slow.close(); host2.close();

console.log('ROOMS E2E: all passed');
process.exit(0);

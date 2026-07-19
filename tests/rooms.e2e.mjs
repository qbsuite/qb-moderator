// Live E2E for the room server protocol (needs a deployed instance —
// not part of CI). Run: node tests/rooms.e2e.mjs [server-url]
const SERVER = process.argv[2] || 'https://qb-rooms.denisliu10.workers.dev';
const WS = SERVER.replace('http', 'ws');

const fail = msg => { console.error('FAIL:', msg); process.exit(1); };
const ok = msg => console.log('  ok ', msg);

function connect(code, name, role) {
  const ws = new WebSocket(`${WS}/rooms/${code}/ws?name=${name}&role=${role}`);
  const queue = [];
  const waiters = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
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

// question log relay
host.sendJson({ t: 'qlog', qlog: [{ label: 'TU 1', question: 'Who?', answer: 'X', summary: 'Kim +10' }] });
await p2.next(m => m.t === 'qlog' && m.qlog.length === 1, 'p2 gets qlog');
ok('qlog relay');

// late joiner gets the stored snapshot + roster + qlog
const late = await connect(code, 'Late', 'player');
const wl = await late.next(m => m.t === 'welcome', 'late welcome');
if (wl.snapshot?.label !== 'TU 1') fail('late joiner missing snapshot');
if (!wl.roster.some(r => r.name === 'Host' && r.role === 'host')) fail('roster missing host');
if (!(wl.qlog && wl.qlog.length === 1 && wl.qlog[0].label === 'TU 1')) fail('late joiner missing qlog');
ok('late-join snapshot + roster + qlog');

// leave fan-out
p1.close();
await host.next(m => m.t === 'leave' && m.name === 'Kim', 'leave fan-out');
ok('leave fan-out');

console.log('ROOMS E2E: all passed');
process.exit(0);

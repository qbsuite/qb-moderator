// rooms/worker.js — the qb-moderator room server (Cloudflare Worker +
// one Durable Object per room).
//
// v1 is a HOST-AUTHORITATIVE relay (a deliberate simplification of the
// docs/rooms.md server-authoritative design, revisit for remote play):
// the game engine runs in the host's browser; the DO does the two
// things only a server can do — atomic first-buzz arbitration and
// fan-out — plus it stores the latest display snapshot for late
// joiners. Phones connect as players and send exactly one message kind
// (buzz); the host relays state and arms/disarms the buzzers.
//
// Protocol (all JSON text frames):
//   player -> DO : {t:'buzz'}
//                  {t:'pong', n, ts}       echo of a ping (RTT sample)
//   host   -> DO : {t:'state', snapshot}   display snapshot, stored + fanned out
//                  {t:'arm'} / {t:'disarm'} open/close the buzzers
//   DO -> client : {t:'welcome', snapshot, armed, roster}
//                  {t:'join'|'leave', name, role}
//                  {t:'buzz', name}        winning buzz, buzzers close
//                  {t:'rejected'}          buzz while closed / lost the race (only to sender)
//                  {t:'state', snapshot} / {t:'arm'} / {t:'disarm'}
//   DO -> player : {t:'ping', n, ts}       RTT probe (sent on join + each arm)
//   DO -> host   : {t:'buzz_pending', name} FIRST arrival, sent the instant
//                  the collection window opens — moderators stop reading on
//                  this; the equalized winner ({t:'buzz'}) may differ and
//                  follows at window close
//
// Buzz arbitration is LATENCY-EQUALIZED: the first buzz while armed opens
// a short collection window (sized to the slowest connected player's
// measured RTT, capped); every buzz arriving within it competes, and the
// winner is the earliest ESTIMATED PRESS TIME (arrival − RTT/2, capped)
// rather than earliest arrival — so a cross-country player races a local
// one fairly. Clients that never pong have no RTT estimate: they get zero
// compensation and, if no one has an estimate, a 0ms window — i.e. plain
// first-arrival, exactly the old behavior (fully backward compatible).
//
// Rooms are temporary: no registry, the room code IS the DO name; a
// room with no connections hibernates for free and its state is
// meaningless once everyone leaves.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (request.method === 'POST' && url.pathname === '/rooms') {
      // Claim a FRESH room: the code is the DO name, so an unclaimed
      // code could collide with a live room or inherit a dead room's
      // stale state. The DO's /claim rejects codes that are active or
      // not yet expired; retry until one sticks. 31^4 ≈ 923k codes and
      // rooms expire (see RoomDO TTL), so exhaustion isn't a concern —
      // collisions are just re-rolled.
      for (let i = 0; i < 8; i++) {
        let code = '';
        const bytes = crypto.getRandomValues(new Uint8Array(4));
        for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch('https://do/claim', { method: 'POST' });
        if (r.ok) return Response.json({ code }, { headers: CORS });
      }
      return new Response('no free room codes, try again', { status: 503, headers: CORS });
    }

    const m = url.pathname.match(/^\/rooms\/([A-Z2-9]{4})\/ws$/);
    if (m) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }

    return new Response('qb-moderator room server', { headers: CORS });
  },
};

// Rooms self-destruct after this long without any activity (message or
// connection): the alarm wipes storage and closes sockets, so the code
// returns to the pool with no stale state.
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

// Latency equalization tuning. The compensation cap doubles as the
// anti-abuse bound: a client faking lag (delaying its pongs) can backdate
// its buzzes by at most MAX_COMP_MS, and inflated RTTs are visible to the
// host in the roster. The window cap bounds how long a winner
// announcement can lag the first arrival.
const RTT_SAMPLES = 8;      // per-player samples kept (median is used)
const MAX_COMP_MS = 100;    // cap on arrival backdating (= RTT/2 cap)
const MAX_WINDOW_MS = 200;  // cap on the buzz collection window

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = null; // in-flight buzz collection window (in-memory only)
  }

  /** Any activity pushes the self-destruct alarm back by the TTL. */
  touch() {
    return this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, 'room expired'); } catch (e) { /* closing */ }
    }
    await this.ctx.storage.deleteAll();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/claim') {
      const created = await this.ctx.storage.get('createdAt');
      const active = this.ctx.getWebSockets().length > 0;
      if (created && (active || Date.now() - created < ROOM_TTL_MS)) {
        return new Response('room code in use', { status: 409 });
      }
      await this.ctx.storage.deleteAll();   // expired leftover state, if any
      await this.ctx.storage.put('createdAt', Date.now());
      await this.touch();
      return new Response('claimed');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    await this.touch();
    const name = (url.searchParams.get('name') || 'guest').slice(0, 40);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ name, role });

    const [snapshot, armed, qlog] = await Promise.all([
      this.ctx.storage.get('snapshot'),
      this.ctx.storage.get('armed'),
      this.ctx.storage.get('qlog'),
    ]);
    server.send(JSON.stringify({
      t: 'welcome', snapshot: snapshot ?? null, armed: !!armed,
      qlog: qlog ?? [], roster: this.roster(),
    }));
    this.broadcast({ t: 'join', name, role }, server);
    this.pingSocket(server); // first RTT sample right away
    return new Response(null, { status: 101, webSocket: client });
  }

  roster() {
    return this.ctx.getWebSockets().map(ws => {
      const a = ws.deserializeAttachment() || {};
      return { name: a.name, role: a.role, rtt: this.rttOf(a) };
    });
  }

  // ---------- latency equalization ----------

  /** Median of the connection's recent RTT samples (null = no data). */
  rttOf(att) {
    const s = att.rtts || [];
    if (!s.length) return null;
    const sorted = [...s].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** How far to backdate this player's buzz arrivals. */
  compOf(att) {
    const r = this.rttOf(att);
    return r == null ? 0 : Math.min(r / 2, MAX_COMP_MS);
  }

  /** Collection window: long enough for the slowest player's buzz to make
   *  it in. 0 when no player has RTT data (old clients / in-person LAN
   *  rooms stay effectively instant). */
  buzzWindow() {
    let w = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.role !== 'player') continue;
      const r = this.rttOf(a);
      if (r != null) w = Math.max(w, Math.min(r, MAX_WINDOW_MS));
    }
    return w;
  }

  pingSocket(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role !== 'player') return;
    att.pingN = (att.pingN || 0) + 1;
    att.pingTs = Date.now();
    ws.serializeAttachment(att);
    try { ws.send(JSON.stringify({ t: 'ping', n: att.pingN, ts: att.pingTs })); } catch (e) { /* closing */ }
  }

  pingPlayers() {
    for (const ws of this.ctx.getWebSockets()) this.pingSocket(ws);
  }

  /** Close the collection window: earliest estimated press time wins.
   *  Losers hear their rejection BEFORE the winner broadcast so their UI
   *  settles on "X buzzed". */
  resolveBuzz() {
    const cands = this.pending || [];
    this.pending = null;
    if (!cands.length) return;
    cands.sort((a, b) => a.adj - b.adj);
    for (const c of cands.slice(1)) {
      try { c.ws.send(JSON.stringify({ t: 'rejected' })); } catch (e) { /* closing */ }
    }
    this.broadcast({ t: 'buzz', name: cands[0].name });
  }

  broadcast(obj, except = null) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(msg); } catch (e) { /* closing socket */ }
    }
  }

  sendToHosts(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.role !== 'host') continue;
      try { ws.send(msg); } catch (e) { /* closing socket */ }
    }
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const att = ws.deserializeAttachment() || {};
    await this.touch();

    if (att.role === 'player') {
      if (msg.t === 'pong') {
        // RTT sample. The nonce check stops stale/replayed pongs from
        // inflating the estimate beyond what actually delaying the pong
        // can achieve (which the MAX_COMP_MS cap bounds anyway).
        if (msg.n === att.pingN && att.pingTs) {
          const rtt = Date.now() - att.pingTs;
          att.pingTs = null;
          att.rtts = [...(att.rtts || []), rtt].slice(-RTT_SAMPLES);
          ws.serializeAttachment(att);
        }
        return;
      }
      if (msg.t !== 'buzz') return;
      const now = Date.now();
      if (this.pending) {
        // A window is open: this buzz competes on estimated press time.
        this.pending.push({ ws, name: att.name, adj: now - this.compOf(att) });
        return;
      }
      // Atomic window-open: the DO processes messages serially (and the
      // input gate holds new events during the storage ops), so exactly
      // one buzz opens the window and closes the gate for everyone who
      // arrives after it resolves.
      const armed = await this.ctx.storage.get('armed');
      if (!armed) { ws.send(JSON.stringify({ t: 'rejected' })); return; }
      await this.ctx.storage.put('armed', false);
      this.pending = [{ ws, name: att.name, adj: now - this.compOf(att) }];
      // Hosts hear about the FIRST arrival immediately (the moderator must
      // stop reading now); the equalized winner follows at window close.
      this.sendToHosts({ t: 'buzz_pending', name: att.name });
      setTimeout(() => this.resolveBuzz(), this.buzzWindow());
      return;
    }

    // host messages
    if (msg.t === 'state') {
      await this.ctx.storage.put('snapshot', msg.snapshot ?? null);
      this.broadcast({ t: 'state', snapshot: msg.snapshot ?? null }, ws);
    } else if (msg.t === 'arm') {
      await this.ctx.storage.put('armed', true);
      this.broadcast({ t: 'arm' }, ws);
      this.pingPlayers(); // refresh RTT estimates once per question cycle
    } else if (msg.t === 'disarm') {
      await this.ctx.storage.put('armed', false);
      this.broadcast({ t: 'disarm' }, ws);
    } else if (msg.t === 'qlog') {
      // Completed-question log (text + answer + result) so players can
      // browse what was read; stored for late joiners.
      await this.ctx.storage.put('qlog', msg.qlog ?? []);
      this.broadcast({ t: 'qlog', qlog: msg.qlog ?? [] }, ws);
    }
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    this.broadcast({ t: 'leave', name: att.name, role: att.role }, ws);
  }
}

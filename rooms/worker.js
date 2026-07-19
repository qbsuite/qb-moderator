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
//   host   -> DO : {t:'state', snapshot}   display snapshot, stored + fanned out
//                  {t:'arm'} / {t:'disarm'} open/close the buzzers
//   DO -> client : {t:'welcome', snapshot, armed, roster}
//                  {t:'join'|'leave', name, role}
//                  {t:'buzz', name}        first buzz wins, buzzers close
//                  {t:'rejected'}          buzz while closed (only to sender)
//                  {t:'state', snapshot} / {t:'arm'} / {t:'disarm'}
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
      let code = '';
      const bytes = crypto.getRandomValues(new Uint8Array(4));
      for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      return Response.json({ code }, { headers: CORS });
    }

    const m = url.pathname.match(/^\/rooms\/([A-Z2-9]{4})\/ws$/);
    if (m) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }

    return new Response('qb-moderator room server', { headers: CORS });
  },
};

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') || 'guest').slice(0, 40);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ name, role });

    const [snapshot, armed] = await Promise.all([
      this.ctx.storage.get('snapshot'),
      this.ctx.storage.get('armed'),
    ]);
    server.send(JSON.stringify({
      t: 'welcome', snapshot: snapshot ?? null, armed: !!armed,
      roster: this.roster(),
    }));
    this.broadcast({ t: 'join', name, role }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  roster() {
    return this.ctx.getWebSockets().map(ws => {
      const a = ws.deserializeAttachment() || {};
      return { name: a.name, role: a.role };
    });
  }

  broadcast(obj, except = null) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(msg); } catch (e) { /* closing socket */ }
    }
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const att = ws.deserializeAttachment() || {};

    if (att.role === 'player') {
      if (msg.t !== 'buzz') return;
      // Atomic first-buzz arbitration: the DO processes messages
      // serially, so the first buzz closes the gate for everyone else.
      const armed = await this.ctx.storage.get('armed');
      if (!armed) { ws.send(JSON.stringify({ t: 'rejected' })); return; }
      await this.ctx.storage.put('armed', false);
      this.broadcast({ t: 'buzz', name: att.name });
      return;
    }

    // host messages
    if (msg.t === 'state') {
      await this.ctx.storage.put('snapshot', msg.snapshot ?? null);
      this.broadcast({ t: 'state', snapshot: msg.snapshot ?? null }, ws);
    } else if (msg.t === 'arm') {
      await this.ctx.storage.put('armed', true);
      this.broadcast({ t: 'arm' }, ws);
    } else if (msg.t === 'disarm') {
      await this.ctx.storage.put('armed', false);
      this.broadcast({ t: 'disarm' }, ws);
    }
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    this.broadcast({ t: 'leave', name: att.name, role: att.role }, ws);
  }
}

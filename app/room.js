// room.js — host-side client for the room server (rooms/worker.js).
//
// CANONICAL COPY — vendored byte-identical by consensus-scorekeeper
// (src/vendor/room.js there). Keep the exported API stable; protocol
// changes must be backward-compatible (see SPEC.md, room protocol).
//
// The host app stays the engine authority; this module just carries the
// relay protocol: create a room, hold the host WebSocket (with
// auto-reconnect), send state/arm/disarm, surface player joins and
// buzzes. Players use app/player.html, not this module.

export const DEFAULT_SERVER = 'https://qb-rooms.denisliu10.workers.dev';

export async function createRoom(server = DEFAULT_SERVER) {
  const r = await fetch(server + '/rooms', { method: 'POST' });
  if (!r.ok) throw new Error('room create failed: HTTP ' + r.status);
  return (await r.json()).code;
}

/**
 * Connect as host. handlers: {onBuzz(name), onBuzzPending(name),
 * onJoin(name), onLeave(name), onOpen(), onClose()}. onBuzzPending fires
 * the instant the server's buzz window opens (first arrival — stop
 * reading NOW); onBuzz follows with the latency-equalized winner, who
 * may differ. Reconnects automatically until close() is called.
 */
export function connectHost(code, handlers, server = DEFAULT_SERVER) {
  const wsUrl = server.replace(/^http/, 'ws') + `/rooms/${code}/ws?name=host&role=host`;
  let ws = null;
  let closed = false;

  function open() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => handlers.onOpen?.();
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'buzz') handlers.onBuzz?.(m.name);
      else if (m.t === 'buzz_pending') handlers.onBuzzPending?.(m.name);
      else if (m.t === 'join' && m.role === 'player') handlers.onJoin?.(m.name);
      else if (m.t === 'leave' && m.role === 'player') handlers.onLeave?.(m.name);
      else if (m.t === 'welcome') {
        for (const r of m.roster || []) {
          if (r.role === 'player') handlers.onJoin?.(r.name);
        }
      }
    };
    ws.onclose = () => {
      handlers.onClose?.();
      if (!closed) setTimeout(open, 2000);
    };
  }
  open();

  return {
    code,
    server,
    playerUrl() {
      const u = new URL('player.html', location.href);
      u.searchParams.set('code', code);
      if (server !== DEFAULT_SERVER) u.searchParams.set('server', server);
      return u.toString();
    },
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    close() { closed = true; try { ws.close(); } catch (e) { /* no-op */ } },
  };
}

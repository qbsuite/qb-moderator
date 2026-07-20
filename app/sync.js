// sync.js — clock-offset and scheduled-playback math for the audio
// broadcast protocol (classic script, like vendor/reveal_units.js:
// attaches globalThis.qbSync; ESM/node consumers import it for the
// side effect and read the global).
//
// The room server stamps audio messages with its own clock (`sv` at
// relay; `at` = sv + lead for scheduled starts). Every client — host
// included — estimates offset = serverClock − localClock from a
// client-initiated {t:'sync', c} → {t:'sync', c, s} exchange, then
// converts server instants to local ones. All functions are pure; the
// callers own the timers and the Audio elements.
(function () {
'use strict';

// One completed sync exchange: sent at local c, server replied stamped
// s, reply received at local r. NTP-style midpoint estimate; the error
// is bounded by path asymmetry (≤ rtt/2).
function sampleFromExchange(c, s, r) {
  var rtt = r - c;
  return { rtt: rtt, offset: s + rtt / 2 - r };
}

// The min-RTT sample carries the least queuing noise — use its offset.
function bestOffset(samples) {
  var best = null;
  for (var i = 0; i < samples.length; i++) {
    if (!best || samples[i].rtt < best.rtt) best = samples[i];
  }
  return best ? best.offset : null;
}

// ms from local `now` until server instant `at` (negative = already
// passed: start immediately and seek forward by the overshoot).
function playDelay(at, offset, now) {
  return (at - offset) - now;
}

// Seek target when starting `lateMs` after the scheduled instant: the
// missed wall time scaled by playbackRate.
function lateSeek(t, lateMs, rate) {
  return t + (lateMs / 1000) * (rate || 1);
}

// Seek target for a stamped anchor message {pos, sv, rate, playing}:
// the host's position `pos` plus, while playing, the audio that elapsed
// since the server relayed it. (`t` is the message-type key on the
// wire, so positions travel as `pos`.)
function anchorTarget(msg, offset, now) {
  if (!msg.playing) return msg.pos;
  var elapsed = Math.max(0, (now + offset) - msg.sv);
  return msg.pos + (elapsed / 1000) * (msg.rate || 1);
}

// Per-question start gate: go when every connected player has resolved
// (blob downloaded or failed) or the deadline passed. An empty room
// resolves immediately.
function gateResolved(names, resolved, deadline, now) {
  if (now >= deadline) return true;
  for (var i = 0; i < names.length; i++) {
    if (!resolved.has(names[i])) return false;
  }
  return true;
}

globalThis.qbSync = {
  sampleFromExchange: sampleFromExchange,
  bestOffset: bestOffset,
  playDelay: playDelay,
  lateSeek: lateSeek,
  anchorTarget: anchorTarget,
  gateResolved: gateResolved,
};
})();

// app.js — qb-moderator host console.
//
// Layout (settled with Denis via mockups, July 2026): full-width
// question text, set/mode/roster/settings in the top bar, consensus-
// scorekeeper-style team panels underneath, chronological history in a
// right sidebar. Three reading modes (audio / reveal / full text); in
// full-text mode the host clicks the word a buzz landed on, which gives
// exact power/neg positions with no clock at all. Bonuses read part by
// part, revealed as they're scored, with the tossup kept on screen.
//
// All game logic lives in engine/engine.js; this file is data loading,
// audio/reveal clocks, and DOM. Reveal-unit splitting comes from the
// canonical vendor/reveal_units.js (shared with the site reader).
//
// Data contracts consumed (SPEC.md): the site's R2 data plane
// (catalog.json, sets/{slug}.json) and the qb-audio dataset.

import { initialState, reduce, scores, teamScores } from '../engine/engine.js';
import * as audio from './audio.js';
import { createRoom, connectHost } from './room.js';

const { questionUnits, slowSpans, SLOW_FACTOR } = globalThis.qbRevealUnits;

const QDATA_BASE = 'https://pub-b5f94e8d4cc648abb0e35b7ca4444c65.r2.dev';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- app state ----------
let CAT = null;            // catalog.json
let SET = null;            // sets/{slug}.json payload
let packet = null;         // current packet {number, tossups, bonuses}
let packetLabel = '';      // "Packet 7"
let tuIdx = -1;            // index into packet.tossups
let state = initialState({});
let cur = null;            // {q, units, powerIdx, superpowerIdx, mode, unitIdx, mapper, slow, timer, bonus}
let pendingBuzz = null;    // {unitIdx, ts}
let selPlayer = null;      // the buzzer, once known
let controlling = null;    // player who got the tossup
let teamList = [];         // team names in display order
const qidMeta = {};        // qid -> {label: "Packet 7 · Tossup 4"}
const player = audio.createPlayer();

let room = null;           // connected room (room.js) or null
let roomArmed = null;      // last arm/disarm sent, to avoid spam
const connected = new Set();  // player names currently connected via the room
const qlog = [];           // completed questions [{label, question, answer, summary}]

function dispatch(ev) { state = reduce(state, ev); render(); }

// ---------- room mode (phones as buzzers) ----------
$('roombtn').onclick = async () => {
  if (room) {   // already hosting: copy the player join link
    const url = room.playerUrl();
    try { await navigator.clipboard.writeText(url); } catch (e) { prompt('Player link:', url); }
    $('roombtn').textContent = '🌐 ' + room.code + ' ✓';
    setTimeout(() => { if (room) $('roombtn').textContent = '🌐 ' + room.code; }, 1200);
    return;
  }
  $('roombtn').disabled = true;
  try {
    const code = await createRoom();
    room = connectHost(code, {
      onBuzz: handleRemoteBuzz,
      onBuzzPending: handleRemoteBuzzPending,
      onJoin: name => {
        connected.add(name);
        if (name && !state.players.includes(name)) {
          dispatch({ type: 'player_join', player: name, team: null });
        } else render();
      },
      onLeave: name => { connected.delete(name); render(); },
      onOpen: () => {   // resync after (re)connect
        roomArmed = null;
        room.send({ t: 'qlog', qlog });
        render();
      },
    });
    $('roombtn').textContent = '🌐 ' + code;
    $('roombtn').title = 'Click to copy the player join link';
  } finally {
    $('roombtn').disabled = false;
  }
};

// First arrival at the server (buzz window just opened): stop the clock
// NOW and pin the buzz position — the equalized winner may be someone
// else and follows in handleRemoteBuzz within the window (<=200ms).
function handleRemoteBuzzPending(name) {
  if (!cur || state.phase !== 'reading' || pendingBuzz) return;
  pauseReading();
  pendingBuzz = { unitIdx: posNow(), ts: Date.now(), tentative: true };
  selPlayer = name;
  render();
}

function handleRemoteBuzz(name) {
  const lockouts = state.current ? state.current.lockouts : [];
  if (pendingBuzz && pendingBuzz.tentative) {
    // Resolution of a pending remote buzz: keep the pinned position,
    // attribute it to the equalized winner.
    if (lockouts.includes(name)) {
      // Winner is locked out: undo the pause, reopen the buzzers.
      pendingBuzz = null; selPlayer = null;
      roomArmed = null;
      resumeReading();
      syncRoom(); render();
      return;
    }
    delete pendingBuzz.tentative;
    if (!state.players.includes(name)) state = reduce(state, { type: 'player_join', player: name, team: null });
    selPlayer = name;
    render();
    return;
  }
  // No pending (old worker without buzz_pending, or state changed): the
  // original single-message path.
  if (!cur || state.phase !== 'reading' || pendingBuzz) { syncRoom(); return; }
  if (lockouts.includes(name)) { roomArmed = null; syncRoom(); return; }  // reopen buzzers
  if (!state.players.includes(name)) state = reduce(state, { type: 'player_join', player: name, team: null });
  pauseReading();
  pendingBuzz = { unitIdx: posNow(), ts: Date.now() };
  selPlayer = name;
  render();
}

function buildSnapshot() {
  const totals = scores(state);
  const tTotals = teamScores(state);
  const lockouts = state.current ? state.current.lockouts : [];
  return {
    label: cur ? (qidMeta[cur.q._id]?.label || '') : '',
    teams: teamList.map(t => ({ name: t, score: tTotals[t] ?? 0 })),
    players: state.players.map(p => ({
      name: p, team: state.teams[p] || null,
      score: totals[p] ?? 0, locked: lockouts.includes(p),
    })),
  };
}

function syncRoom() {
  if (!room) return;
  room.send({ t: 'state', snapshot: buildSnapshot() });
  const wantArmed = !!(cur && state.phase === 'reading' && !pendingBuzz);
  if (wantArmed !== roomArmed) {
    roomArmed = wantArmed;
    room.send({ t: wantArmed ? 'arm' : 'disarm' });
  }
}

// ---------- sheets ----------
for (const id of ['setsheet', 'rostersheet', 'settingsheet']) {
  $(id).onclick = e => { if (e.target === $(id)) $(id).classList.remove('open'); };
}
$('setbtn').onclick = () => $('setsheet').classList.add('open');
$('gearbtn').onclick = () => $('settingsheet').classList.add('open');
$('rosterbtn').onclick = () => { buildRosterEditor(); $('rostersheet').classList.add('open'); };

// ---------- set & packet picker ----------
// In TTS-audio mode the picker only offers sets whose tossups ALL have
// audio (the catalog carries every tossup id + set index; the audio
// index is the qid list — coverage is one client-side pass). Other
// modes list everything. If the audio index fails to load the filter
// stays off and the per-question reveal fallback covers the gaps.
let audioFullSets = null;  // Set of catalog set indices at 100% tossup audio

fetch(QDATA_BASE + '/catalog.json').then(r => r.json()).then(cat => {
  CAT = cat;
  renderSetList($('setsearch').value);
  computeAudioCoverage();
});
audio.loadAudioIndex().then(computeAudioCoverage).catch(() => {});
$('setsheet').classList.add('open');   // boot straight into picking a set

function computeAudioCoverage() {
  if (!CAT || !audio.indexLoaded()) return;   // needs both fetches
  const total = new Array(CAT.sets.length).fill(0);
  const covered = new Array(CAT.sets.length).fill(0);
  const ids = CAT.tossups.id, setIdx = CAT.tossups.set;
  for (let i = 0; i < ids.length; i++) {
    const s = setIdx[i];
    if (s < 0) continue;
    total[s]++;
    if (audio.hasAudio(ids[i])) covered[s]++;
  }
  audioFullSets = new Set();
  for (let s = 0; s < CAT.sets.length; s++) {
    if (total[s] && covered[s] === total[s]) audioFullSets.add(s);
  }
  renderSetList($('setsearch').value);
}

function renderSetList(filter) {
  if (!CAT) return;
  const q = filter.trim().toLowerCase();
  const audioOnly = $('modepick2').value === 'audio' && audioFullSets;
  const opts = CAT.sets.filter((s, i) =>
    (!q || s.name.toLowerCase().includes(q)) && (!audioOnly || audioFullSets.has(i)));
  $('setlist').innerHTML = opts.slice(0, 200).map(s =>
    `<option value="${s.slug}">${esc(s.name)} (diff ${s.difficulty ?? '?'})</option>`).join('');
  if (!SET) {
    $('setstatus').textContent = audioOnly
      ? `${opts.length} sets with full TTS audio` : `${opts.length} sets`;
  }
}
$('setsearch').oninput = e => renderSetList(e.target.value);

// Reading mode is choosable in the set sheet (before starting) AND in
// the header (mid-game); the two selects stay in sync. Audio mode
// narrows the set list, so a mode change re-renders it.
$('modepick2').onchange = () => { $('modepick').value = $('modepick2').value; renderSetList($('setsearch').value); };
$('modepick').onchange = () => { $('modepick2').value = $('modepick').value; renderSetList($('setsearch').value); };

$('setlist').onchange = async () => {
  const slug = $('setlist').value;
  $('setstatus').textContent = 'Loading set…';
  SET = await fetch(QDATA_BASE + '/sets/' + slug + '.json').then(r => r.json());
  $('packetpick').innerHTML = SET.packets.map((p, i) =>
    `<option value="${i}">Packet ${p.number ?? i + 1}${p.name ? ' — ' + esc(p.name) : ''} (${p.tossups.length} TU)</option>`).join('');
  const withAudio = SET.packets.flatMap(p => p.tossups).filter(t => audio.hasAudio(t._id)).length;
  const total = SET.packets.reduce((n, p) => n + p.tossups.length, 0);
  $('setstatus').textContent = `${SET.name} — ${withAudio}/${total} tossups have TTS audio`;
  $('loadbtn').disabled = false;
};

$('loadbtn').onclick = () => {
  packet = SET.packets[+$('packetpick').value];
  packetLabel = 'Packet ' + (packet.number ?? +$('packetpick').value + 1);
  tuIdx = -1;
  $('setsheet').classList.remove('open');
  nextQuestion();
};

// ---------- upload your own packets (parsed client-side) ----------
// Each .docx/.txt file becomes one packet, parsed IN THE BROWSER by
// the vendored qb-packet-parser (qbreader's parser, JS port — see
// vendor/qb_packet_parser.mjs; no hosted service involved). Its output
// is the same qbreader doc shape the R2 sets use — question_sanitized,
// answers, even auto-classified categories — so everything downstream
// (reading modes, bonuses, rooms) works unchanged. Uploads have no TTS
// audio; audio mode falls back to reveal automatically.
let ParserClass = null;   // lazy-loaded: the bundle is ~2 MB

// The parser needs to know whether the packet has question numbers /
// category tags, and guessing wrong ruins the parse — so try the
// combinations and keep the parse that finds the most questions.
async function parsePacketAuto(input, isDocx, name) {
  let best = null;
  for (const hasQuestionNumbers of [true, false]) {
    for (const hasCategoryTags of [false, true]) {
      try {
        const parser = new ParserClass({ hasQuestionNumbers, hasCategoryTags });
        const { data, warnings } = isDocx
          ? await parser.parseDocxPacket(input, name)
          : parser.parsePacket(input, name);
        const n = (data.tossups?.length || 0) + (data.bonuses?.length || 0);
        const score = n * 100 - warnings.length;
        if (n && (!best || score > best.score)) best = { data, warnings, score };
      } catch (e) { /* wrong settings for this packet — try the next combo */ }
    }
  }
  return best;
}

$('upload').onchange = async () => {
  const files = [...$('upload').files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) return;
  $('loadbtn').disabled = true;
  if (!ParserClass) {
    $('setstatus').textContent = 'Loading parser…';
    ParserClass = (await import('./vendor/qb_packet_parser.mjs')).default;
  }
  const packets = [];
  let warned = 0;
  for (const f of files) {
    $('setstatus').textContent = `Parsing ${f.name}…`;
    const isDocx = /\.docx$/i.test(f.name);
    const input = isDocx ? await f.arrayBuffer() : await f.text();
    const best = await parsePacketAuto(input, isDocx, f.name);
    if (!best) {
      $('setstatus').textContent = `${f.name}: couldn’t find any questions — is it a packet in docx/txt form?`;
      return;
    }
    warned += best.warnings.length;
    const number = packets.length + 1;
    packets.push({
      number,
      name: f.name.replace(/\.[^.]*$/, ''),
      tossups: (best.data.tossups || []).map((t, j) => ({ ...t, _id: `up-${number}-t${j}` })),
      bonuses: (best.data.bonuses || []).map((b, j) => ({ ...b, _id: `up-${number}-b${j}` })),
    });
  }
  SET = { name: files.length === 1 ? packets[0].name : `Uploaded (${files.length} packets)`, packets };
  $('packetpick').innerHTML = SET.packets.map((p, i) =>
    `<option value="${i}">Packet ${p.number}${p.name ? ' — ' + esc(p.name) : ''} (${p.tossups.length} TU)</option>`).join('');
  const tus = packets.reduce((n, p) => n + p.tossups.length, 0);
  const bs = packets.reduce((n, p) => n + p.bonuses.length, 0);
  $('setstatus').textContent = `${SET.name} — ${tus} tossups, ${bs} bonuses`
    + (warned ? ` · ${warned} parse warning${warned > 1 ? 's' : ''} (check questions look right)` : '')
    + ' (no TTS audio for uploads)';
  $('loadbtn').disabled = false;
};

// ---------- live settings ----------
$('optScoring').onchange = () =>
  dispatch({ type: 'configure', patch: { scoring: $('optScoring').checked } });
$('optSuper').onchange = () =>
  dispatch({ type: 'configure', patch: { points: { superpower: $('optSuper').checked ? 20 : null } } });
$('optBonuses').onchange = render;
$('optChecker').onchange = render;

// ---------- question flow ----------
// Record a finished question into the players' browsable log.
function logQuestion() {
  if (!cur) return;
  const qid = cur.q._id;
  const events = state.log.filter(e => e.qid === qid);
  const summary = events.map(e =>
    e.kind === 'dead' ? 'dead'
    : `${e.player} ${e.points > 0 ? '+' : ''}${e.points}`).join(' · ') || 'skipped';
  qlog.push({
    label: qidMeta[qid]?.label || '',
    question: cur.q.question_sanitized || cur.q.question || '',
    answer: cur.q.answer || '',
    summary,
  });
  if (room) room.send({ t: 'qlog', qlog });
}

async function nextQuestion() {
  stopClocks();
  logQuestion();
  pendingBuzz = null; selPlayer = null; controlling = null;
  tuIdx++;
  if (tuIdx >= packet.tossups.length) { renderPacketDone(); return; }
  const q = packet.tossups[tuIdx];
  const { units, powerIdx, superpowerIdx } = questionUnits(q.question_sanitized || q.question || '');
  let mode = $('modepick').value;
  const wantedAudio = mode === 'audio';
  if (mode === 'audio' && !audio.hasAudio(q._id)) mode = 'reveal';  // never full text: no spoilers
  cur = { q, units, powerIdx, superpowerIdx, mode, noAudio: wantedAudio && mode !== 'audio',
          unitIdx: mode === 'text' ? null : 0,
          slow: mode === 'reveal' ? slowSpans(units.map(u => u.t)) : null,
          mapper: null, timer: null, bonus: null };
  qidMeta[q._id] = { label: `${packetLabel} · Tossup ${tuIdx + 1}` };
  dispatch({ type: 'question_start', qid: q._id, powerIdx, superpowerIdx, unitCount: units.length });

  if (mode === 'audio') {
    cur.mapper = await audio.positionMapper(q._id, units.length);
    player.load(q._id);
    player.el.playbackRate = voiceRate();
    player.el.ontimeupdate = () => {
      if (!cur || state.phase !== 'reading') return;
      cur.unitIdx = cur.mapper(player.el.currentTime, player.el.duration);
      renderProgress();
    };
    player.el.onended = () => dispatch({ type: 'reading_finished' });
    player.el.onerror = () => degradeToReveal();
    player.play().catch(() => degradeToReveal());
  } else if (mode === 'reveal') {
    scheduleReveal();
  }
  render();
}

function degradeToReveal() {
  if (!cur || cur.mode !== 'audio') return;
  cur.mode = 'reveal'; cur.degraded = true;
  cur.unitIdx = 0;
  cur.slow = slowSpans(cur.units.map(u => u.t));
  scheduleReveal();
  render();
}

// Reveal pacing = the reader's engine: 60000/wpm per unit, slowed by
// SLOW_FACTOR when the current OR next unit is in a slow note-run span
// (reader.js scheduleStep — same lookahead, same factor). The slider is
// read live each tick, so speed changes apply mid-question.
function msPerUnit(i) {
  const base = 60000 / (+$('wpm').value || 380);
  return cur.slow && (cur.slow.has(i) || cur.slow.has(i + 1)) ? base * SLOW_FACTOR : base;
}

$('wpm').value = +localStorage.qbmodWpm || 380;
$('wpmval').textContent = $('wpm').value;
$('wpm').oninput = () => {
  $('wpmval').textContent = $('wpm').value;
  localStorage.qbmodWpm = $('wpm').value;
};

// TTS playback speed — the reader's vrate control: pitch-preserved
// playbackRate, live mid-question. Reapplied after each load(): setting
// src can reset playbackRate to the default.
function voiceRate() { return Math.min(2, Math.max(0.5, +$('vrate').value || 0.95)); }
try { player.el.preservesPitch = true; } catch (e) { /* older browsers */ }
$('vrate').value = +localStorage.qbmodVrate || 0.95;
$('vrateval').textContent = voiceRate().toFixed(2) + 'x';
$('vrate').oninput = () => {
  $('vrateval').textContent = voiceRate().toFixed(2) + 'x';
  localStorage.qbmodVrate = $('vrate').value;
  player.el.playbackRate = voiceRate();
};

function scheduleReveal() {
  clearTimeout(cur.timer);
  cur.timer = setTimeout(() => {
    if (!cur || state.phase !== 'reading' || cur.mode !== 'reveal') return;
    cur.unitIdx++;
    if (cur.unitIdx >= cur.units.length) {
      renderQText();
      dispatch({ type: 'reading_finished' });
      return;
    }
    renderQText();
    scheduleReveal();
  }, msPerUnit(cur.unitIdx));
}

function pauseReading() {
  if (!cur) return;
  if (cur.mode === 'audio') player.pause();
  if (cur.mode === 'reveal') clearTimeout(cur.timer);
}

function resumeReading() {
  if (!cur || state.phase !== 'reading') return;
  if (cur.mode === 'audio') player.resume();
  if (cur.mode === 'reveal') scheduleReveal();
}

function stopClocks() {
  player.stop();
  if (cur) clearTimeout(cur.timer);
}

const posNow = () => (cur && cur.mode !== 'text' ? cur.unitIdx : null);

// Eligible = able to take this buzz (not locked out).
function eligible() {
  const lockouts = state.current ? state.current.lockouts : [];
  return state.players.filter(p => !lockouts.includes(p));
}

function buzz(unitIdx = undefined) {
  if (!cur || state.phase !== 'reading') return;
  pauseReading();
  pendingBuzz = { unitIdx: unitIdx === undefined ? posNow() : unitIdx, ts: Date.now() };
  const el = eligible();
  selPlayer = el.length === 1 ? el[0] : null;
  render();
}

function applyVerdict(result, points = null) {
  if (!pendingBuzz || !selPlayer) return;
  dispatch({ type: 'buzz', player: selPlayer, unitIdx: pendingBuzz.unitIdx, ts: pendingBuzz.ts });
  const given = $('givenanswer').value.trim() || null;
  const source = given && suggested() === result ? 'checker' : 'host';
  if (result === 'correct') controlling = selPlayer;
  dispatch({ type: 'verdict', result, points, source, answer: given });
  pendingBuzz = null; selPlayer = null;
  $('givenanswer').value = '';
  resumeReading();
  render();
}

// Player-row point buttons: during reading = buzz + verdict in one tap;
// with a pending buzz = assign player + verdict; otherwise = adjustment.
function directPoints(p, v) {
  if (cur && state.phase === 'reading') {
    pauseReading();
    pendingBuzz = { unitIdx: posNow(), ts: Date.now() };
    selPlayer = p;
    applyVerdict(v > 0 ? 'correct' : 'wrong', v);
  } else if (pendingBuzz) {
    selPlayer = p;
    applyVerdict(v > 0 ? 'correct' : 'wrong', v);
  } else if (v !== 0) {
    dispatch({ type: 'award', player: p, points: v, reason: 'adjust' });
  }
}

function suggested() {
  const given = $('givenanswer').value.trim();
  if (!given || !cur || typeof qbCheckAnswer !== 'function') return null;
  try {
    const v = qbCheckAnswer(cur.q.answer, given);
    return v.directive === 'accept' ? 'correct'
      : v.directive === 'reject' ? 'wrong' : 'prompt';
  } catch (e) { return null; }
}

// ---------- controls ----------
$('buzz').onclick = () => buzz();
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && cur && state.phase === 'reading'
      && document.activeElement.tagName !== 'INPUT'
      && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); buzz(); }
});
$('playbtn').onclick = () => {
  if (!cur || state.phase !== 'reading') return;
  if (cur.mode === 'audio') { if (player.el.paused) player.resume(); else player.pause(); }
  if (cur.mode === 'reveal') {
    if (cur.timer) { clearTimeout(cur.timer); cur.timer = null; } else scheduleReveal();
  }
};
$('finishedbtn').onclick = () => dispatch({ type: 'reading_finished' });
$('deadbtn').onclick = () => { pauseReading(); pendingBuzz = null; dispatch({ type: 'dead' }); };
$('nextbtn').onclick = () => { if (state.phase === 'done') dispatch({ type: 'next' }); nextQuestion(); };
$('vcorrect').onclick = () => applyVerdict('correct');
$('vwrong').onclick = () => applyVerdict('wrong');
$('givenanswer').oninput = renderSuggestion;

// ---------- rendering ----------
function render() {
  renderHeader();
  renderScoring();
  renderHistory();
  renderMain();
  syncRoom();
}

function renderHeader() {
  $('setname').innerHTML = !packet ? 'no packet loaded'
    : `${esc(SET.name)} · ${esc(packetLabel)} · <b>TU ${Math.min(tuIdx + 1, packet.tossups.length)}</b>/${packet.tossups.length}`;
}

function renderMain() {
  if (!cur) return;
  const q = cur.q;
  const phase = state.phase;
  const hostReads = cur.mode === 'text';

  $('modeline').innerHTML =
    cur.degraded ? '<span class="warn">⚠ audio failed for this question — revealing text</span>'
    : cur.noAudio ? '<span class="warn">⚠ no TTS audio for this question — revealing text</span>'
    : cur.mode === 'audio' ? '♪ reading aloud — text hidden until the end'
    : cur.mode === 'reveal' ? 'word-by-word reveal'
    : 'full text — you read';

  renderQText();

  const showAnswer = hostReads || phase === 'done';
  $('anspanel').classList.toggle('hidden', !showAnswer);
  if (showAnswer) {
    $('anspanel').innerHTML = '<span class="lbl">Answer</span> ' + (q.answer || '');
  }

  $('progress').classList.toggle('hidden', cur.mode !== 'audio' || phase === 'done');
  $('speedctl').classList.toggle('hidden', cur.mode !== 'reveal' || phase !== 'reading');
  $('ratectl').classList.toggle('hidden', cur.mode !== 'audio' || phase !== 'reading');
  $('playbtn').classList.toggle('hidden', hostReads || phase !== 'reading');
  $('finishedbtn').classList.toggle('hidden', !hostReads || phase !== 'reading');
  $('finishedbtn').disabled = !!state.current?.readingFinished;
  $('deadbtn').classList.toggle('hidden', phase === 'done' || phase === 'idle');
  $('nextbtn').classList.toggle('hidden', !packet);
  $('nextbtn').disabled = false;

  // The buzz button: armed while reading (except full-text mode, where
  // clicking the buzzed word replaces it); red while adjudicating.
  const armed = phase === 'reading' && !hostReads;
  $('buzz').classList.toggle('hidden', !(armed || pendingBuzz));
  $('buzz').classList.toggle('buzzed', !!pendingBuzz);
  $('buzz').textContent = pendingBuzz ? 'buzzed' : 'BUZZ (space)';
  $('buzz').disabled = !!pendingBuzz;

  $('adjrow').classList.toggle('hidden', !pendingBuzz);
  if (pendingBuzz) {
    $('givenanswer').classList.toggle('hidden', !$('optChecker').checked);
    const dis = !selPlayer;
    $('vcorrect').disabled = dis;
    $('vwrong').disabled = dis;
    renderSuggestion();
  }
  renderBonus();
}

function renderQText() {
  if (!cur) return;
  if (cur.mode === 'audio' && state.phase !== 'done') {
    $('qtext').innerHTML = '<i class="faint">♪ Audio playing — text hidden so everyone can play.</i>';
    return;
  }
  const hostReads = cur.mode === 'text';
  const upto = (cur.mode === 'reveal' && state.phase !== 'done') ? cur.unitIdx : cur.units.length;
  const buzzAt = pendingBuzz ? pendingBuzz.unitIdx : null;
  $('qtext').innerHTML = cur.units.map((u, i) => {
    const mark = (u.t === '(*)' || u.t === '(+)');
    const cls = [
      mark ? 'mark' : '',
      i >= upto ? 'unread' : '',
      hostReads && state.phase === 'reading' && !mark ? 'w' : '',
      buzzAt !== null && i === buzzAt ? 'buzzword' : '',
    ].filter(Boolean).join(' ');
    return (i && u.sep ? ' ' : '') + (cls ? `<span class="${cls}" data-i="${i}">${esc(u.t)}</span>` : esc(u.t));
  }).join('');
  if (hostReads && state.phase === 'reading') {
    for (const w of $('qtext').querySelectorAll('.w')) {
      w.onclick = () => buzz(+w.dataset.i);
    }
  }
}

function renderProgress() {
  const d = player.el.duration;
  if (d && isFinite(d)) $('progressfill').style.width = (player.el.currentTime / d * 100) + '%';
}

function renderSuggestion() {
  const s = suggested();
  $('suggestion').innerHTML = !s ? ''
    : s === 'prompt' ? '<span class="faint">checker: PROMPT</span>'
    : s === 'correct' ? '<span class="good">checker: ACCEPT</span>'
    : '<span class="bad">checker: REJECT</span>';
}

// ---------- bonus: parts revealed as they're scored ----------
function renderBonus() {
  const el = $('bonuspanel');
  const bonus = packet && packet.bonuses && packet.bonuses[tuIdx];
  const active = $('optBonuses').checked && cur && state.phase === 'done' && controlling && bonus;
  el.classList.toggle('hidden', !active);
  if (!active) { el.dataset.for = ''; return; }
  if (el.dataset.for === String(tuIdx)) return;   // built; button handlers mutate in place
  el.dataset.for = String(tuIdx);
  cur.bonus = { next: 0, total: 0 };

  const parts = bonus.parts_sanitized || bonus.parts || [];
  const answers = bonus.answers || [];
  el.innerHTML = `<div class="blabel">Bonus · ${esc(state.teams[controlling] || controlling)}</div>
    <div class="leadin">${esc(bonus.leadin_sanitized || bonus.leadin || '')}</div>`
    + parts.map((p, i) => `<div class="bpart hidden" id="bp${i}">
        <div class="bq">${esc(p)}</div>
        <div class="bans">→ ${answers[i] || ''}
          <button class="good" data-i="${i}" data-v="${state.config.points.bonusPart}">+${state.config.points.bonusPart}</button>
          <button data-i="${i}" data-v="0">0</button></div>
      </div>`).join('')
    + `<div class="controls hidden" id="bonusdone"><span class="muted" id="bonustotal"></span></div>`;
  el.querySelector('#bp0')?.classList.remove('hidden');
  for (const b of el.querySelectorAll('.bans button')) {
    b.onclick = () => {
      const i = +b.dataset.i, v = +b.dataset.v;
      cur.bonus.total += v;
      if (v) state = reduce(state, { type: 'award', player: controlling, points: v, reason: 'bonus' });
      const bans = b.parentElement;
      const spend = document.createElement('span');
      spend.className = 'scored ' + (v ? 'good' : 'faint');
      spend.textContent = v ? '+' + v : '0';
      for (const x of bans.querySelectorAll('button')) x.remove();
      bans.appendChild(spend);
      const next = el.querySelector('#bp' + (i + 1));
      if (next) next.classList.remove('hidden');
      else {
        el.querySelector('#bonusdone').classList.remove('hidden');
        el.querySelector('#bonustotal').textContent =
          `bonus total: +${cur.bonus.total} to ${state.teams[controlling] || controlling}`;
      }
      renderScoring(); renderHistory();
    };
  }
}

// ---------- scoring panels (consensus-scorekeeper style) ----------
function rosterColumns() {
  const cols = teamList.map(t => ({ team: t, players: state.players.filter(p => state.teams[p] === t) }));
  const unassigned = state.players.filter(p => !state.teams[p]);
  if (unassigned.length) cols.push({ team: null, players: unassigned });
  return cols;
}

function renderScoring() {
  const totals = scores(state);
  const tTotals = teamScores(state);
  const lockouts = state.current ? state.current.lockouts : [];
  const midQuestion = state.phase === 'reading' || state.phase === 'buzzed' || !!pendingBuzz;
  const pad = state.config.scoring ? [...state.config.pointPad, 0] : [];
  const cols = rosterColumns();
  const bar = `<div class="scorebar"><span class="grow"></span>
    <button id="addplayerq" title="Add a player">+ player</button>
    <button id="addteamq" title="Add a team">+ team</button></div>`;
  $('scoring').innerHTML = bar + cols.map(col => {
    const head = col.team === null
      ? `<div class="teamhead"><span class="tname unassigned">Players</span>${teamList.length ? '' : ''}</div>`
      : `<div class="teamhead"><span class="tname" data-team="${esc(col.team)}">${esc(col.team)}</span><span class="tscore">${tTotals[col.team] ?? 0}</span></div>`;
    const rows = col.players.map(p => {
      const locked = lockouts.includes(p);
      const offline = room && !connected.has(p);
      return `<div class="prow ${locked ? 'locked' : ''} ${p === selPlayer ? 'droptarget' : ''}" data-p="${esc(p)}">
        <span class="handle">≡</span>
        <span class="pname" data-p="${esc(p)}">${esc(p)}${offline
          ? ' <span class="faint" title="not connected to the room">○</span>' : ''}</span>
        <span class="pscore">${totals[p] ?? 0}</span>
        <span class="pbtns">${pad.map(v =>
          `<button class="${v > 0 ? 'good' : v < 0 ? 'bad' : ''}" data-v="${v}"
             ${locked && midQuestion ? 'disabled' : ''}>${v > 0 ? '+' + v : v}</button>`).join('')}</span>
      </div>`;
    }).join('');
    return `<div class="team" data-teamcol="${col.team === null ? '' : esc(col.team)}">${head}${rows}</div>`;
  }).join('');

  $('addteamq').onclick = () => {
    let n = teamList.length + 1;
    while (teamList.includes('Team ' + n)) n++;
    teamList.push('Team ' + n);
    render();
  };
  $('addplayerq').onclick = () => {
    const name = (prompt('Player name') || '').trim();
    if (!name || state.players.includes(name)) return;
    dispatch({ type: 'player_join', player: name, team: teamList[0] ?? null });
  };

  for (const t of $('scoring').querySelectorAll('.tname[data-team]')) {
    t.onclick = () => {
      const from = t.dataset.team;
      const to = prompt('Rename team', from);
      if (!to || to === from || teamList.includes(to)) return;
      teamList[teamList.indexOf(from)] = to;
      for (const p of state.players) {
        if (state.teams[p] === from) state = reduce(state, { type: 'player_move', player: p, team: to });
      }
      render();
    };
  }
  for (const row of $('scoring').querySelectorAll('.prow')) {
    const p = row.dataset.p;
    for (const b of row.querySelectorAll('.pbtns button')) {
      b.onclick = () => directPoints(p, +b.dataset.v);
    }
    // With a pending buzz, tapping a player's name marks them as the buzzer.
    row.querySelector('.pname').onclick = () => {
      if (pendingBuzz && eligible().includes(p)) { selPlayer = p; render(); }
    };
    row.querySelector('.handle').onpointerdown = e => startDrag(e, p, row);
  }
}

// Pointer drag: drop on a player row -> insert before them (adopting
// their team); drop on a team block -> append to that team.
function startDrag(e, p, row) {
  if (e.button) return;
  e.preventDefault();
  row.classList.add('dragging');
  const teams = [...$('scoring').querySelectorAll('.team')];
  const rows = [...$('scoring').querySelectorAll('.prow')];
  const under = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return { row: el ? el.closest('.prow') : null, team: el ? el.closest('.team') : null };
  };
  const move = ev => {
    const o = under(ev.clientX, ev.clientY);
    for (const t of teams) t.classList.toggle('dragover', t === o.team && (!o.row || o.row === row));
    for (const r of rows) r.classList.toggle('droptarget', r === o.row && r !== row);
  };
  const up = ev => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    row.classList.remove('dragging');
    for (const t of teams) t.classList.remove('dragover');
    for (const r of rows) r.classList.remove('droptarget');
    const o = under(ev.clientX, ev.clientY);
    if (o.row && o.row !== row) {
      const before = o.row.dataset.p;
      dispatch({ type: 'player_move', player: p, team: state.teams[before] ?? null, before });
    } else if (o.team) {
      const team = o.team.dataset.teamcol || null;
      if (team !== (state.teams[p] ?? null)) dispatch({ type: 'player_move', player: p, team });
      else render();
    } else render();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// ---------- history sidebar: chronological, grouped by tossup ----------
function renderHistory() {
  const rows = [];
  let lastQid = null;
  for (const e of state.log) {
    if (e.qid && e.qid !== lastQid) {
      lastQid = e.qid;
      rows.push(`<div class="tuhead">${esc(qidMeta[e.qid]?.label || 'Tossup')}</div>`);
    }
    const cls = e.points > 0 ? 'good' : e.points < 0 ? 'bad' : '';
    const label = e.kind === 'dead' ? '<span class="faint">dead</span>'
      : `${esc(e.player ?? '')} · ${e.kind}${e.answer ? ' · “' + esc(e.answer) + '”' : ''}`;
    const pts = e.kind === 'dead' ? '' : (e.points > 0 ? '+' + e.points : String(e.points));
    rows.push(`<li><span class="pts ${cls}">${pts}</span><span>${label}</span></li>`);
  }
  if (cur && state.phase !== 'done' && state.phase !== 'idle' && state.current) {
    if (state.current.qid !== lastQid) {
      rows.push(`<div class="tuhead">${esc(qidMeta[state.current.qid]?.label || 'Tossup')}</div>`);
    }
    rows.push('<li><span class="pts faint">…</span><span class="faint">reading</span></li>');
  }
  const el = $('histlist');
  el.innerHTML = rows.join('');
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

// ---------- roster editor: bulk team/player entry ----------
function buildRosterEditor() {
  const blocks = [];
  const cols = rosterColumns();
  for (const col of cols.filter(c => c.team !== null)) blocks.push(col);
  // teams with no players yet still get a block
  for (const t of teamList) {
    if (!blocks.some(b => b.team === t)) blocks.push({ team: t, players: [] });
  }
  const unassigned = state.players.filter(p => !state.teams[p]);
  if (unassigned.length || !blocks.length) blocks.push({ team: '', players: unassigned });
  $('tblocks').innerHTML = blocks.map(b => `
    <div class="tblock">
      <label>Team name</label><input class="tn" value="${esc(b.team || '')}">
      <label>Players</label><textarea class="tp">${b.players.map(esc).join('\n')}</textarea>
    </div>`).join('');
}
$('addteamblock').onclick = () => {
  const div = document.createElement('div');
  div.className = 'tblock';
  div.innerHTML = '<label>Team name</label><input class="tn" placeholder="Team name">' +
    '<label>Players</label><textarea class="tp" placeholder="One name per line"></textarea>';
  $('tblocks').appendChild(div);
};
$('rostersave').onclick = () => {
  const wanted = [];          // [{name, team}] in display order
  const newTeams = [];
  for (const block of $('tblocks').querySelectorAll('.tblock')) {
    const team = block.querySelector('.tn').value.trim() || null;
    if (team && !newTeams.includes(team)) newTeams.push(team);
    const names = block.querySelector('.tp').value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    for (const name of names) {
      if (!wanted.some(w => w.name === name)) wanted.push({ name, team });
    }
  }
  teamList = newTeams;
  for (const p of [...state.players]) {
    if (!wanted.some(w => w.name === p)) state = reduce(state, { type: 'player_leave', player: p });
  }
  // join/move each in order; append-to-end walks establish the order
  for (const w of wanted) {
    state = reduce(state, state.players.includes(w.name)
      ? { type: 'player_move', player: w.name, team: w.team }
      : { type: 'player_join', player: w.name, team: w.team });
  }
  $('rostersheet').classList.remove('open');
  render();
};

// ---------- packet end ----------
function renderPacketDone() {
  cur = null; pendingBuzz = null;
  $('modeline').textContent = '';
  $('qtext').innerHTML = '<i class="faint">Packet finished — pick another (📦); scores carry over.</i>';
  $('anspanel').classList.add('hidden');
  $('progress').classList.add('hidden');
  $('bonuspanel').classList.add('hidden');
  $('adjrow').classList.add('hidden');
  for (const id of ['buzz', 'playbtn', 'finishedbtn', 'deadbtn', 'nextbtn']) $(id).classList.add('hidden');
  renderHeader(); renderScoring(); renderHistory();
  $('setsheet').classList.add('open');
}

render();

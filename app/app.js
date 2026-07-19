// app.js — qb-moderator solo host console (v0).
//
// One tab, one host. Three reading modes:
//   audio  — TTS read-aloud (qb-audio); text + answer hidden until the
//            question ends, so the host can play too.
//   reveal — word-by-word text reveal (the reader's pacing contract:
//            wpm + slow note-run spans); host can play.
//   text   — full text + answer visible: the host IS the moderator and
//            reads from the screen.
// All game logic lives in engine/engine.js; this file is data loading,
// audio/reveal clocks, and DOM.
//
// Data contracts consumed (SPEC.md): the site's R2 data plane
// (catalog.json, sets/{slug}.json) and the qb-audio dataset.

import { initialState, reduce, scores, teamScores } from '../engine/engine.js';
import { questionUnits, slowSpans, SLOW_FACTOR } from './vendor/reveal_units.js';
import * as audio from './audio.js';

const QDATA_BASE = 'https://pub-b5f94e8d4cc648abb0e35b7ca4444c65.r2.dev';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- app state ----------
let CAT = null;            // catalog.json
let SET = null;            // sets/{slug}.json payload
let packet = null;         // current packet {number, tossups, bonuses}
let tuIdx = -1;            // index into packet.tossups
let state = null;          // engine state
let cur = null;            // {q, units, powerIdx, superpowerIdx, mode, unitIdx, mapper, slow, timer}
let pendingBuzz = null;    // {unitIdx, ts} captured at buzz time, player picked after
let selPlayer = null;
let controlling = null;    // player who got the tossup (bonus goes to them)
let teamList = [];         // team names, in display order
const player = audio.createPlayer();

function dispatch(ev) { state = reduce(state, ev); render(); }
const readingMode = () => document.querySelector('input[name=rmode]:checked').value;

// ---------- setup: catalog + pickers ----------
fetch(QDATA_BASE + '/catalog.json').then(r => r.json()).then(cat => {
  CAT = cat;
  $('setupstatus').textContent = cat.sets.length + ' sets';
  renderSetList('');
  audio.loadAudioIndex().catch(() => {});   // warm; absence just falls back to reveal
});

function renderSetList(filter) {
  const q = filter.trim().toLowerCase();
  const opts = CAT.sets.filter(s => !q || s.name.toLowerCase().includes(q));
  $('setpick').innerHTML = opts.slice(0, 200).map(s =>
    `<option value="${s.slug}">${esc(s.name)} (diff ${s.difficulty ?? '?'})</option>`).join('');
}
$('setsearch').oninput = e => renderSetList(e.target.value);

$('setpick').onchange = async () => {
  const slug = $('setpick').value;
  $('setupstatus').textContent = 'Loading set…';
  SET = await fetch(QDATA_BASE + '/sets/' + slug + '.json').then(r => r.json());
  $('packetpick').innerHTML = SET.packets.map((p, i) =>
    `<option value="${i}">Packet ${p.number ?? i + 1}${p.name ? ' — ' + esc(p.name) : ''} (${p.tossups.length} TU)</option>`).join('');
  $('setupstatus').textContent = SET.name;
  $('startbtn').disabled = false;
};

$('startbtn').onclick = () => {
  packet = SET.packets[+$('packetpick').value];
  state = initialState({
    scoring: $('optScoring').checked,
    points: { superpower: $('optSuper').checked ? 20 : null },
  });
  for (const p of $('playersin').value.split(',').map(s => s.trim()).filter(Boolean)) {
    state = reduce(state, { type: 'player_join', player: p });
  }
  tuIdx = -1;
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');
  nextQuestion();
};

// ---------- question flow ----------
async function nextQuestion() {
  stopClocks();
  pendingBuzz = null; selPlayer = null; controlling = null;
  tuIdx++;
  if (tuIdx >= packet.tossups.length) { renderPacketDone(); return; }
  const q = packet.tossups[tuIdx];
  const { units, powerIdx, superpowerIdx } = questionUnits(q.question_sanitized || q.question || '');
  let mode = readingMode();
  if (mode === 'audio' && !audio.hasAudio(q._id)) mode = 'reveal';  // no spoilers
  cur = { q, units, powerIdx, superpowerIdx, mode,
          unitIdx: mode === 'text' ? null : 0,
          slow: mode === 'reveal' ? slowSpans(units.map(u => u.t)) : null,
          mapper: null, timer: null };
  dispatch({ type: 'question_start', qid: q._id, powerIdx, superpowerIdx, unitCount: units.length });

  if (mode === 'audio') {
    cur.mapper = await audio.positionMapper(q._id, units.length);
    player.load(q._id);
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
  cur.mode = 'reveal';
  cur.unitIdx = 0;
  cur.slow = slowSpans(cur.units.map(u => u.t));
  scheduleReveal();
  render();
}

function msPerUnit(i) {
  const base = 60000 / Math.min(800, Math.max(80, +$('wpm').value || 250));
  return cur.slow && cur.slow.has(i) ? base * SLOW_FACTOR : base;
}

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

function buzz() {
  if (!cur || state.phase !== 'reading') return;
  pauseReading();
  pendingBuzz = { unitIdx: posNow(), ts: Date.now() };
  selPlayer = state.players.length === 1 ? state.players[0] : null;
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

// Player-box point buttons: during reading this IS the buzz (that player,
// current position, those points); with a pending buzz it assigns the
// player; otherwise it's a direct score adjustment.
function directPoints(p, v) {
  if (state.phase === 'reading') {
    pauseReading();
    pendingBuzz = { unitIdx: posNow(), ts: Date.now() };
    selPlayer = p;
    applyVerdict(v > 0 ? 'correct' : 'wrong', v);
  } else if (pendingBuzz) {
    selPlayer = p;
    applyVerdict(v > 0 ? 'correct' : 'wrong', v);
  } else if (v !== 0) {   // a 0 adjustment outside a buzz is a no-op
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
$('buzz').onclick = buzz;
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && state && state.phase === 'reading'
      && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); buzz(); }
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

$('addplayerbtn').onclick = () => {
  const name = $('newplayer').value.trim();
  if (!name) return;
  $('newplayer').value = '';
  dispatch({ type: 'player_join', player: name, team: teamList[0] ?? null });
};
$('addteambtn').onclick = () => {
  let n = teamList.length + 1;
  while (teamList.includes('Team ' + n)) n++;
  teamList.push('Team ' + n);
  render();
};

// ---------- rendering ----------
function render() {
  if (!state) return;
  renderRoster();
  renderHistory();
  if (!cur) return;
  const q = cur.q;
  $('qlabel').textContent = `Tossup ${tuIdx + 1}/${packet.tossups.length}`;
  $('qmeta').textContent = [q.category, q.subcategory !== q.category ? q.subcategory : null,
    { audio: '♪ audio', reveal: 'reveal', text: 'manual read' }[cur.mode]].filter(Boolean).join(' · ');
  renderQText();

  // Host-plays modes hide the answer until the question is over.
  const showAnswer = cur.mode === 'text' || state.phase === 'done';
  $('anspanel').classList.toggle('hidden', !showAnswer);
  if (showAnswer) $('anspanel').innerHTML = 'Answer: ' + (q.answer || '');

  $('progress').classList.toggle('hidden', cur.mode !== 'audio');
  $('playbtn').classList.toggle('hidden', cur.mode === 'text' || state.phase !== 'reading');
  $('finishedbtn').classList.toggle('hidden', state.phase !== 'reading');
  $('finishedbtn').disabled = !!state.current?.readingFinished;

  const buzzable = state.phase === 'reading';
  $('buzz').classList.toggle('hidden', !buzzable && !pendingBuzz);
  $('buzz').classList.toggle('armed', buzzable);
  $('buzz').disabled = !buzzable;
  $('adjudicate').classList.toggle('hidden', !pendingBuzz);
  $('checkerrow').classList.toggle('hidden', !$('optChecker').checked);
  if (pendingBuzz) renderAdjudicate();
  $('nextbtn').disabled = !(state.phase === 'done');
  renderBonus();
}

function renderQText() {
  if (!cur) return;
  if (cur.mode === 'audio' && state.phase !== 'done') {
    $('qtext').innerHTML = '<i class="muted">♪ Reading aloud — text hidden so everyone can play. Buzz any time.</i>';
    return;
  }
  // reveal: only units before unitIdx are visible; text/done: everything.
  const upto = (cur.mode === 'reveal' && state.phase !== 'done') ? cur.unitIdx : cur.units.length;
  $('qtext').innerHTML = cur.units.map((u, i) => {
    const mark = (u.t === '(*)' || u.t === '(+)');
    const cls = [mark ? 'mark' : '', i >= upto ? 'unread' : ''].filter(Boolean).join(' ');
    return (i && u.sep ? ' ' : '') + (cls ? `<span class="${cls}">${esc(u.t)}</span>` : esc(u.t));
  }).join('');
}

function renderProgress() {
  const d = player.el.duration;
  if (d && isFinite(d)) $('progressfill').style.width = (player.el.currentTime / d * 100) + '%';
}

function renderAdjudicate() {
  const lockouts = state.current ? state.current.lockouts : [];
  $('playerchips').innerHTML = state.players.map(p => {
    const locked = lockouts.includes(p);
    return `<button class="chip ${p === selPlayer ? 'sel' : ''} ${locked ? 'locked' : ''}"
      data-p="${esc(p)}" ${locked ? 'disabled' : ''}>${esc(p)}</button>`;
  }).join('');
  for (const b of $('playerchips').querySelectorAll('button')) {
    b.onclick = () => { selPlayer = b.dataset.p; render(); };
  }
  const dis = !selPlayer;
  $('vcorrect').disabled = dis;
  $('vwrong').disabled = dis;
  renderSuggestion();
}

function renderSuggestion() {
  const s = suggested();
  $('suggestion').textContent = !s ? ''
    : s === 'prompt' ? 'Checker: PROMPT — ask for more'
    : 'Checker suggests: ' + s.toUpperCase();
}

function renderBonus() {
  const el = $('bonuspanel');
  const bonus = packet.bonuses && packet.bonuses[tuIdx];
  const enabled = $('optBonuses').checked;
  if (!enabled || state.phase !== 'done' || !controlling || !bonus) {
    el.classList.add('hidden');
    if (!enabled) el.dataset.for = '';
    return;
  }
  el.classList.remove('hidden');
  if (el.dataset.for !== String(tuIdx)) {
    el.dataset.for = String(tuIdx);
    const parts = bonus.parts_sanitized || bonus.parts || [];
    const answers = bonus.answers || [];
    el.innerHTML = `<b>Bonus for ${esc(controlling)}</b>
      <div class="muted">${esc(bonus.leadin_sanitized || bonus.leadin || '')}</div>`
      + parts.map((p, i) => `<div class="bpart">${esc(p)}
          <div class="ans">${answers[i] || ''}</div>
          <button data-i="${i}">+${state.config.points.bonusPart}</button></div>`).join('');
    for (const b of el.querySelectorAll('button')) {
      b.onclick = () => {
        dispatch({ type: 'award', player: controlling,
                   points: state.config.points.bonusPart, reason: 'bonus' });
        b.disabled = true;
      };
    }
  }
}

// ---------- roster: teams, drag, per-player point boxes ----------
function rosterColumns() {
  const cols = teamList.map(t => ({ team: t, players: state.players.filter(p => state.teams[p] === t) }));
  const unassigned = state.players.filter(p => !state.teams[p]);
  if (unassigned.length || !teamList.length) cols.push({ team: null, players: unassigned });
  return cols;
}

function renderRoster() {
  const totals = scores(state);
  const tTotals = teamScores(state);
  const lockouts = state.current ? state.current.lockouts : [];
  const pad = state.config.scoring ? [...state.config.pointPad, 0] : [];
  $('teamsrow').innerHTML = rosterColumns().map(col => {
    const head = col.team === null
      ? `<div class="teamhead muted"><span>Unassigned</span></div>`
      : `<div class="teamhead" data-team="${esc(col.team)}"><span>${esc(col.team)}</span><span>${tTotals[col.team] ?? 0}</span></div>`;
    const boxes = col.players.map(p => `
      <div class="pbox ${lockouts.includes(p) ? 'locked' : ''}" data-p="${esc(p)}">
        <div class="pname" data-drag="${esc(p)}"><span>${esc(p)}</span><b class="pscore">${totals[p] ?? 0}</b></div>
        <div class="pbtns">${pad.map(v =>
          `<button class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}" data-v="${v}"
             ${lockouts.includes(p) && state.phase !== 'done' && state.phase !== 'idle' ? 'disabled' : ''}>
             ${v > 0 ? '+' + v : v}</button>`).join('')}</div>
      </div>`).join('');
    return `<div class="teamcol" data-teamcol="${col.team === null ? '' : esc(col.team)}">${head}${boxes}</div>`;
  }).join('');

  for (const head of $('teamsrow').querySelectorAll('.teamhead[data-team]')) {
    head.onclick = () => {
      const from = head.dataset.team;
      const to = prompt('Rename team', from);
      if (!to || to === from || teamList.includes(to)) return;
      teamList[teamList.indexOf(from)] = to;
      for (const p of state.players) {
        if (state.teams[p] === from) dispatch({ type: 'player_move', player: p, team: to });
      }
      render();
    };
  }
  for (const box of $('teamsrow').querySelectorAll('.pbox')) {
    const p = box.dataset.p;
    for (const b of box.querySelectorAll('.pbtns button')) {
      b.onclick = () => directPoints(p, +b.dataset.v);
    }
    box.querySelector('.pname').onpointerdown = e => startDrag(e, p, box);
  }
}

// Pointer-based drag (HTML5 DnD is unreliable on mobile): track the
// pointer, highlight the team column under it, move on release.
function startDrag(e, p, box) {
  if (e.button) return;
  e.preventDefault();
  box.classList.add('dragging');
  const cols = [...$('teamsrow').querySelectorAll('.teamcol')];
  const colAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.teamcol') : null;
  };
  const move = ev => {
    const over = colAt(ev.clientX, ev.clientY);
    for (const c of cols) c.classList.toggle('dragover', c === over);
  };
  const up = ev => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    box.classList.remove('dragging');
    const over = colAt(ev.clientX, ev.clientY);
    for (const c of cols) c.classList.remove('dragover');
    if (over) {
      const team = over.dataset.teamcol || null;
      if (team !== (state.teams[p] ?? null)) {
        dispatch({ type: 'player_move', player: p, team });
        return;
      }
    }
    render();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function renderHistory() {
  $('history').innerHTML = state.log.slice().reverse().slice(0, 30).map(e => {
    const cls = e.points > 0 ? 'pos' : e.points < 0 ? 'neg' : '';
    return `<li><span class="pts ${cls}">${e.points > 0 ? '+' + e.points : e.points}</span>
      ${esc(e.player ?? '')} · ${e.kind}${e.answer ? ' · “' + esc(e.answer) + '”' : ''}</li>`;
  }).join('');
}

function renderPacketDone() {
  cur = null;
  $('qlabel').textContent = 'Packet finished';
  $('qmeta').textContent = '';
  $('qtext').innerHTML = '<i>Final scores below. Reload to pick another packet.</i>';
  $('anspanel').classList.add('hidden');
  $('progress').classList.add('hidden');
  $('playbtn').classList.add('hidden');
  $('finishedbtn').classList.add('hidden');
  $('buzz').classList.add('hidden');
  $('adjudicate').classList.add('hidden');
  $('bonuspanel').classList.add('hidden');
  $('nextbtn').disabled = true;
  renderRoster(); renderHistory();
}

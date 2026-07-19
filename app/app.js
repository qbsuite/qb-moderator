// app.js — qb-moderator solo host console (v0).
//
// One tab, one host: pick a set + packet, read it (TTS audio or from
// the screen), take buzzes, adjudicate (checker-assisted, host always
// final), keep score. All game logic lives in engine/engine.js; this
// file is data loading + audio + DOM.
//
// Data contracts consumed (SPEC.md): the site's R2 data plane
// (catalog.json, sets/{slug}.json) and the qb-audio dataset.

import { initialState, reduce, scores } from '../engine/engine.js';
import { questionUnits } from './vendor/reveal_units.js';
import * as audio from './audio.js';

const QDATA_BASE = 'https://pub-b5f94e8d4cc648abb0e35b7ca4444c65.r2.dev';

const $ = id => document.getElementById(id);
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------- app state ----------
let CAT = null;            // catalog.json
let SET = null;            // sets/{slug}.json payload
let packet = null;         // current packet {number, tossups, bonuses}
let tuIdx = -1;            // index into packet.tossups
let state = null;          // engine state
let cur = null;            // {q, units, powerIdx, superpowerIdx, mapper, useAudio, unitIdx}
let pendingBuzz = null;    // {unitIdx, ts} captured at buzz time, player picked after
let selPlayer = null;
let controlling = null;    // player who got the tossup (bonus goes to them)
const player = audio.createPlayer();

function dispatch(ev) { state = reduce(state, ev); render(); }

// ---------- setup: catalog + pickers ----------
fetch(QDATA_BASE + '/catalog.json').then(r => r.json()).then(cat => {
  CAT = cat;
  $('setupstatus').textContent = cat.sets.length + ' sets';
  renderSetList('');
  audio.loadAudioIndex().catch(() => {});   // warm; absence just disables audio
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
  const players = $('playersin').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!players.length) { $('setupstatus').textContent = 'Add at least one player.'; return; }
  packet = SET.packets[+$('packetpick').value];
  state = initialState({
    scoring: $('optScoring').checked,
    points: { superpower: $('optSuper').checked ? 20 : null },
  });
  for (const p of players) state = reduce(state, { type: 'player_join', player: p });
  tuIdx = -1;
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');
  nextQuestion();
};

// ---------- question flow ----------
async function nextQuestion() {
  player.stop();
  pendingBuzz = null; selPlayer = null; controlling = null;
  tuIdx++;
  if (tuIdx >= packet.tossups.length) { renderPacketDone(); return; }
  const q = packet.tossups[tuIdx];
  const { units, powerIdx, superpowerIdx } = questionUnits(q.question_sanitized || q.question || '');
  const useAudio = $('optAudio').checked && audio.hasAudio(q._id);
  cur = { q, units, powerIdx, superpowerIdx, useAudio, unitIdx: useAudio ? 0 : null, mapper: null };
  dispatch({ type: 'question_start', qid: q._id, powerIdx, superpowerIdx, unitCount: units.length });

  if (useAudio) {
    cur.mapper = await audio.positionMapper(q._id, units.length);
    player.load(q._id);
    player.el.ontimeupdate = () => {
      if (state.phase !== 'reading' || !cur) return;
      cur.unitIdx = cur.mapper(player.el.currentTime, player.el.duration);
      renderProgress();
      renderQText();
    };
    player.el.onended = () => dispatch({ type: 'reading_finished' });
    player.el.onerror = () => { cur.useAudio = false; cur.unitIdx = null; render(); };
    player.play().catch(() => { cur.useAudio = false; cur.unitIdx = null; render(); });
  }
  render();
}

function buzz() {
  if (!cur || state.phase !== 'reading') return;
  if (cur.useAudio) player.pause();
  pendingBuzz = { unitIdx: cur.useAudio ? cur.unitIdx : null, ts: Date.now() };
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
  if (state.phase === 'reading' && cur.useAudio) player.resume();
  render();
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
  if (!cur || !cur.useAudio) return;
  if (player.el.paused) player.resume(); else player.pause();
};
$('finishedbtn').onclick = () => dispatch({ type: 'reading_finished' });
$('deadbtn').onclick = () => { player.pause(); pendingBuzz = null; dispatch({ type: 'dead' }); };
$('nextbtn').onclick = () => { if (state.phase === 'done') dispatch({ type: 'next' }); nextQuestion(); };
$('vcorrect').onclick = () => applyVerdict('correct');
$('vwrong').onclick = () => applyVerdict('wrong');
$('givenanswer').oninput = renderSuggestion;

// ---------- rendering ----------
function render() {
  if (!cur) return;
  const q = cur.q;
  $('qlabel').textContent = `Tossup ${tuIdx + 1}/${packet.tossups.length}`;
  $('qmeta').textContent = [q.category, q.subcategory !== q.category ? q.subcategory : null,
    cur.useAudio ? '♪ audio' : 'manual read'].filter(Boolean).join(' · ');
  renderQText();
  $('anspanel').innerHTML = 'Answer: ' + (q.answer || '');
  $('progress').classList.toggle('hidden', !cur.useAudio);
  $('playbtn').classList.toggle('hidden', !cur.useAudio);
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
  renderScoreboard();
  renderHistory();
}

function renderQText() {
  if (!cur) return;
  const upto = (cur.useAudio && state.phase !== 'done') ? cur.unitIdx : -1;
  $('qtext').innerHTML = cur.units.map((u, i) => {
    const mark = (u.t === '(*)' || u.t === '(+)');
    const cls = [mark ? 'mark' : '', upto >= 0 && i < upto ? 'read' : ''].filter(Boolean).join(' ');
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
  // Point pad: the pad both scores AND drives flow (verdict with points
  // override) — the voice/manual-read path where position is unknown.
  const pad = state.config.pointPad;
  const padHtml = pad.map(v =>
    `<button class="${v >= 0 ? 'pos' : 'neg'}" data-v="${v}">${v > 0 ? '+' + v : v}</button>`).join('')
    + `<button data-v="0" title="wrong, no penalty">0</button>`;
  let extra = $('padrow').querySelector('.padx');
  if (!extra) {
    extra = document.createElement('span');
    extra.className = 'padx row';
    $('padrow').appendChild(extra);
  }
  extra.innerHTML = state.config.scoring ? padHtml : '';
  for (const b of extra.querySelectorAll('button')) {
    b.onclick = () => applyVerdict(+b.dataset.v > 0 ? 'correct' : 'wrong', +b.dataset.v);
  }
  const dis = !selPlayer;
  for (const b of [$('vcorrect'), $('vwrong'), ...extra.querySelectorAll('button')]) b.disabled = dis;
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
  if (state.phase !== 'done' || !controlling || !bonus) { el.classList.add('hidden'); return; }
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

function renderScoreboard() {
  const totals = scores(state);
  $('scoreboard').innerHTML = state.players.map(p =>
    `<span>${esc(p)} <b>${totals[p]}</b></span>`).join('');
}

function renderHistory() {
  $('history').innerHTML = state.log.slice().reverse().slice(0, 30).map(e => {
    const cls = e.points > 0 ? 'pos2' : e.points < 0 ? 'neg2' : '';
    return `<li><span class="pts ${cls}">${e.points > 0 ? '+' + e.points : e.points}</span>
      ${esc(e.player ?? '')} · ${e.kind}${e.answer ? ' · “' + esc(e.answer) + '”' : ''}</li>`;
  }).join('');
}

function renderPacketDone() {
  cur = null;
  $('qlabel').textContent = 'Packet finished';
  $('qmeta').textContent = '';
  $('qtext').innerHTML = '<i>Final scores below. Pick another packet by reloading.</i>';
  $('anspanel').innerHTML = '';
  $('buzz').classList.add('hidden');
  $('adjudicate').classList.add('hidden');
  $('bonuspanel').classList.add('hidden');
  renderScoreboard(); renderHistory();
}

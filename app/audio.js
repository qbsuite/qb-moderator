// audio.js — qb-audio dataset client for the moderator.
//
// Consumes the qb-audio data contract (see SPEC.md "Data contracts"):
// audio_index.json manifest, tossups/{qid[:2]}/{qid}.opus, and the
// {qid}.json chunk-offset sidecars. This is the REFERENCE sidecar
// implementation — the site reader still uses the proportional
// approximation and should adopt sidecarMapper once this settles.

export const AUDIO_BASE =
  'https://huggingface.co/datasets/uild42/qb-audio/resolve/main';

let HAVE = null;          // Set of qids with audio
let loadP = null;

export function loadAudioIndex() {
  if (HAVE) return Promise.resolve(HAVE);
  if (loadP) return loadP;
  loadP = fetch(AUDIO_BASE + '/audio_index.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(idx => { HAVE = new Set(idx.tossups || []); return HAVE; })
    .catch(err => { loadP = null; throw err; });
  return loadP;
}

export function hasAudio(qid) { return !!(HAVE && HAVE.has(qid)); }
export function audioUrl(qid) {
  return AUDIO_BASE + '/tossups/' + qid.slice(0, 2) + '/' + qid + '.opus';
}
export function sidecarUrl(qid) {
  return AUDIO_BASE + '/tossups/' + qid.slice(0, 2) + '/' + qid + '.json';
}

/**
 * Build a currentTime -> unitIdx mapper for one question.
 *
 * With a sidecar ({v:1, chunks: [[start_s, end_s], ...], texts: [...]}):
 * find the chunk containing t, interpolate linearly across that chunk's
 * word count, and scale the cumulative word position to the question's
 * reveal-unit count. The sidecar texts are the *cleaned* TTS text, so
 * word counts differ slightly from the raw question — per-chunk
 * interpolation bounds the error to within one chunk, far tighter than
 * whole-file proportionality. Silence between chunks maps to the end of
 * the preceding chunk (position holds while nothing is being said).
 *
 * Without a sidecar (pre-sidecar files): proportional fallback,
 * identical to the reader's current behavior.
 */
export async function positionMapper(qid, unitCount) {
  let sidecar = null;
  try {
    const r = await fetch(sidecarUrl(qid));
    if (r.ok) sidecar = await r.json();
  } catch (e) { /* sidecar missing: fall back */ }
  return makeMapper(sidecar, unitCount);
}

/** Pure mapper construction (unit-testable; positionMapper adds the
 * fetch). sidecar may be null → proportional fallback. */
export function makeMapper(sidecar, unitCount) {
  if (!sidecar || !Array.isArray(sidecar.chunks) || !sidecar.chunks.length) {
    return (t, duration) => {
      if (!duration || !isFinite(duration)) return 0;
      return Math.min(unitCount, Math.round(t / duration * unitCount));
    };
  }

  const words = sidecar.texts.map(x => x.split(/\s+/).filter(Boolean).length);
  const cum = [0];
  for (const w of words) cum.push(cum[cum.length - 1] + w);
  const total = cum[cum.length - 1] || 1;

  return (t) => {
    let pos = cum[cum.length - 1];                      // past the last chunk
    for (let i = 0; i < sidecar.chunks.length; i++) {
      const [s, e] = sidecar.chunks[i];
      if (t < s) { pos = cum[i]; break; }               // in the gap before i
      if (t < e) {                                      // inside chunk i
        const frac = e > s ? (t - s) / (e - s) : 1;
        pos = cum[i] + frac * words[i];
        break;
      }
    }
    return Math.min(unitCount, Math.round(pos / total * unitCount));
  };
}

/** One shared element with pause/resume for the buzz flow. */
export function createPlayer() {
  const el = new Audio();
  el.preload = 'auto';
  return {
    el,
    load(qid) { el.src = audioUrl(qid); },
    play() { return el.play(); },
    pause() { el.pause(); },
    resume() { return el.play(); },
    stop() {
      el.onended = el.ontimeupdate = el.onerror = null;
      try { el.pause(); } catch (e) { /* no-op */ }
      el.removeAttribute('src');
      try { el.load(); } catch (e) { /* no-op */ }
    },
  };
}

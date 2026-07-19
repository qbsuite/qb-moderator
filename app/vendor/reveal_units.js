// reveal_units.js — the reveal-unit contract, vendored from the site
// reader (library-of-stock lib/js/reader.js, July 2026) and re-exported
// as an ES module. Unit splitting must stay IDENTICAL across the reader,
// the moderator, and the future room server: powerIdx and buzz positions
// are unit indexes, so a drifted splitter mis-scores powers. If you
// change this, change reader.js in the same commit (and vice versa).
//
// A "unit" is one reveal token: whitespace-split words, except dash-
// joined musical note runs ("E–F♯–G–E"), which split into per-note units
// so score clues don't pop all at once. slowSpans marks note runs for
// slower text-reveal pacing (2.4x); audio mode doesn't use it.

const NOTEISH = /^["“(«]?(?:[A-G](?:♯|♭|#|b)?(?:-?(?:sharp|flat|natural))?|[Dd]o|[Rr]e|[Mm]i|[Ff]a|[Ss]ol|[Ll]a|[Tt]i|[Ss]i)(?:['’]?s)?[”")»\],.;:!?–—-]*$/;
const NOTE_CONT = /^(?:double[-\s]?)?(?:sharps?|flats?|naturals?|longs?|shorts?|repeated|dotted|tied|slurred|staccato|triplets?|high(?:er)?|low(?:er)?|notes?|majors?|minors?|eighths?|quarters?|sixteenths?|thirty|second|halves|half|whole|ascending|descending|rising|falling|pause|rest|sustained|grace|augmented|diminished|perfect|two|three|four|five|six|seven|eight)[”")»\],.;:!?]*$/i;
const NOTE_GLUE = /^(?:and|then|to|or|a|an|back|up|down|again|from|by|via|of|followed)[,.;:]?$/i;
const LONE_DASH = /^[–—-]+$/;
const GLUE_MAX = 3;
export const SLOW_FACTOR = 2.4;

function splitNoteRun(w) {
  if (!/[–—-]/.test(w) || w.length < 3) return null;
  const parts = w.split(/(?<=[–—-])/);
  const merged = [];
  for (const p of parts) {
    if (merged.length && /^(sharp|flat|natural)[–—-]?["”")\],.;:!?]*$/i.test(p)) merged[merged.length - 1] += p;
    else merged.push(p);
  }
  if (merged.length < 3) return null;
  if (!merged.every(p => NOTEISH.test(p))) return null;
  return merged;
}

export function buildUnits(words) {
  const units = [];
  for (const w of words) {
    const parts = splitNoteRun(w);
    if (parts) parts.forEach((p, i) => units.push({ t: p, sep: i === 0 ? ' ' : '' }));
    else units.push({ t: w, sep: ' ' });
  }
  return units;
}

export function slowSpans(words) {
  const slow = new Set();
  let runStart = -1, noteCount = 0, gap = 0;
  const flush = end => {
    if (noteCount >= 3) for (let k = runStart; k < end; k++) slow.add(k);
    runStart = -1; noteCount = 0; gap = 0;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (NOTEISH.test(w)) { if (runStart < 0) runStart = i; noteCount++; gap = 0; }
    else if (runStart >= 0 && (NOTE_CONT.test(w) || LONE_DASH.test(w))) { /* extend, don't count */ }
    else if (runStart >= 0 && NOTE_GLUE.test(w) && gap < GLUE_MAX) { gap++; }
    else if (runStart >= 0) { flush(i); }
  }
  flush(words.length);
  return slow;
}

/** Units for a question's sanitized text + the power/superpower unit
 * indexes ((*) and (+) marks; null when absent). */
export function questionUnits(questionSanitized) {
  const units = buildUnits(questionSanitized.split(/\s+/).filter(Boolean));
  const idxOf = mark => {
    const i = units.findIndex(u => u.t === mark);
    return i === -1 ? null : i;
  };
  return { units, powerIdx: idxOf('(*)'), superpowerIdx: idxOf('(+)') };
}

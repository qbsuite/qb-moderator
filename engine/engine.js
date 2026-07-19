// engine.js — the qb-moderator game engine.
//
// A pure, event-sourced reducer (see SPEC.md). No I/O, no clocks, no
// randomness: callers pass timestamps and reveal-unit positions in the
// events. Scores are always derived from the log via scores(), never
// stored, so host corrections are ordinary log edits.
//
// Runs unchanged in a browser tab (solo mode) and inside the room
// server (v1). Keep it dependency-free and serializable.

/** Fill a scoring config with defaults (see SPEC.md "Scoring config"). */
export function defaultConfig(overrides = {}) {
  const points = {
    power: 15, get: 10, neg: -5, superpower: null, bonusPart: 10,
    ...(overrides.points || {}),
  };
  const pointPad = overrides.pointPad
    || [points.power, points.get, points.neg,
        ...(points.superpower != null ? [points.superpower] : [])];
  return {
    scoring: true,
    humanJudge: false,
    ...overrides,
    points,
    pointPad,
  };
}

export function initialState(config = {}) {
  return {
    config: defaultConfig(config),
    players: [],
    teams: {},            // player -> team name (absent/null = unassigned)
    phase: 'idle',        // idle | reading | buzzed | done
    current: null,        // {qid, powerIdx, superpowerIdx, unitCount,
                          //  readingFinished, buzz, lockouts: []}
    log: [],              // [{qid, player, points, kind, unitIdx, ts}]
  };
}

/** Total points per player, derived from the log. */
export function scores(state) {
  const totals = {};
  for (const p of state.players) totals[p] = 0;
  for (const e of state.log) {
    if (e.player != null) totals[e.player] = (totals[e.player] || 0) + e.points;
  }
  return totals;
}

/** Total points per team (players without a team are excluded). */
export function teamScores(state) {
  const per = scores(state);
  const totals = {};
  for (const p of state.players) {
    const t = state.teams[p];
    if (t) totals[t] = (totals[t] || 0) + per[p];
  }
  return totals;
}

/** A wrong buzz locks out the buzzer's whole team (standard rules);
 * unassigned players lock out individually. */
function teammates(state, player) {
  const t = state.teams[player];
  if (!t) return [player];
  return state.players.filter(p => state.teams[p] === t);
}

/** Kind for a correct buzz at unitIdx, per the rule table. An unknown
 * position (unitIdx null — manual-read/voice mode) is never a power;
 * the host point pad is how those get 15s. (Beware: null < 10 is true
 * in JS, hence the explicit guard.) */
function correctKind(config, current) {
  const { unitIdx } = current.buzz;
  if (unitIdx == null) return 'get';
  if (config.points.superpower != null && current.superpowerIdx != null
      && unitIdx < current.superpowerIdx) return 'superpower';
  if (current.powerIdx != null && unitIdx < current.powerIdx) return 'power';
  return 'get';
}

function correctPoints(config, current) {
  if (!config.scoring) return 0;
  const kind = correctKind(config, current);
  const p = config.points;
  return kind === 'superpower' ? p.superpower : kind === 'power' ? p.power : p.get;
}

/**
 * Apply one event; returns the next state (input state is not mutated).
 * Unknown or out-of-phase events return the state unchanged — the
 * engine is authoritative and simply refuses impossible transitions.
 */
export function reduce(state, event) {
  const { type } = event;

  if (type === 'player_join') {
    if (state.players.includes(event.player)) return state;
    return {
      ...state,
      players: [...state.players, event.player],
      teams: { ...state.teams, [event.player]: event.team ?? null },
    };
  }
  if (type === 'player_leave') {
    const teams = { ...state.teams };
    delete teams[event.player];
    return { ...state, teams, players: state.players.filter(p => p !== event.player) };
  }
  if (type === 'player_move') {
    // Moves between teams AND/OR reorders: the player is re-inserted
    // before event.before (or at the end). team undefined = keep team
    // (pure reorder); team null = unassign.
    if (!state.players.includes(event.player)) return state;
    const players = state.players.filter(p => p !== event.player);
    const at = event.before && players.includes(event.before)
      ? players.indexOf(event.before) : players.length;
    players.splice(at, 0, event.player);
    const team = event.team === undefined
      ? (state.teams[event.player] ?? null) : (event.team ?? null);
    return { ...state, players, teams: { ...state.teams, [event.player]: team } };
  }

  if (type === 'configure') {
    // Live settings change (scoring on/off, point values, humanJudge).
    // The point pad re-derives from the new values unless the patch
    // pins its own. Applies to future verdicts; the log is untouched.
    const merged = {
      ...state.config,
      ...event.patch,
      points: { ...state.config.points, ...(event.patch.points || {}) },
    };
    if (!event.patch.pointPad) delete merged.pointPad;
    return { ...state, config: defaultConfig(merged) };
  }

  if (type === 'question_start') {
    return {
      ...state,
      phase: 'reading',
      current: {
        qid: event.qid,
        powerIdx: event.powerIdx ?? null,
        superpowerIdx: event.superpowerIdx ?? null,
        unitCount: event.unitCount ?? null,
        readingFinished: false,
        buzz: null,
        lockouts: [],
      },
    };
  }

  if (!state.current && type !== 'award') return state;

  if (type === 'reading_finished') {
    if (state.phase !== 'reading') return state;
    return { ...state, current: { ...state.current, readingFinished: true } };
  }

  if (type === 'buzz') {
    // First non-locked-out buzzer wins; reading pauses (caller's job).
    if (state.phase !== 'reading') return state;
    if (state.current.lockouts.includes(event.player)) return state;
    return {
      ...state,
      phase: 'buzzed',
      current: {
        ...state.current,
        buzz: { player: event.player, unitIdx: event.unitIdx, ts: event.ts ?? null },
      },
    };
  }

  if (type === 'verdict') {
    if (state.phase !== 'buzzed') return state;
    const cur = state.current;
    const { player, unitIdx, ts } = cur.buzz;

    if (event.result === 'correct') {
      // event.points overrides the rule table — the host point pad in
      // voice/manual-read mode, where the app can't know the position.
      const entry = {
        qid: cur.qid, player, kind: correctKind(state.config, cur),
        points: event.points ?? correctPoints(state.config, cur), unitIdx, ts,
        source: event.source ?? 'host', answer: event.answer ?? null,
      };
      return {
        ...state,
        phase: 'done',
        current: { ...cur, buzz: null },
        log: [...state.log, entry],
      };
    }

    // Wrong: neg only while the question was still being read.
    const neg = state.config.scoring && !cur.readingFinished;
    const entry = {
      qid: cur.qid, player, kind: cur.readingFinished ? 'miss' : 'neg',
      points: event.points ?? (neg ? state.config.points.neg : 0), unitIdx, ts,
      source: event.source ?? 'host', answer: event.answer ?? null,
    };
    const lockouts = [...new Set([...cur.lockouts, ...teammates(state, player)])];
    // Everyone locked out after reading finished -> nothing left, dead.
    const exhausted = cur.readingFinished
      && state.players.length > 0
      && state.players.every(p => lockouts.includes(p));
    return {
      ...state,
      phase: exhausted ? 'done' : 'reading',
      current: { ...cur, buzz: null, lockouts },
      log: [...state.log, entry],
    };
  }

  if (type === 'award') {
    // Direct score line: the host point pad (voice mode's primary
    // scoring path), bonus parts, and one-off corrections.
    return {
      ...state,
      log: [...state.log, {
        qid: state.current ? state.current.qid : null,
        player: event.player, kind: event.reason ?? 'award',
        points: event.points, unitIdx: null, ts: event.ts ?? null,
        source: 'host', answer: null,
      }],
    };
  }

  if (type === 'dead') {
    if (state.phase !== 'reading' && state.phase !== 'buzzed') return state;
    return { ...state, phase: 'done', current: { ...state.current, buzz: null } };
  }

  if (type === 'next') {
    if (state.phase !== 'done') return state;
    return { ...state, phase: 'idle', current: null };
  }

  if (type === 'override') {
    // Host edits a past score line; totals recompute from the log.
    const log = state.log.map((e, i) =>
      i === event.entryIdx ? { ...e, points: event.points, overridden: true } : e);
    return { ...state, log };
  }

  return state;
}

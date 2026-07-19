# qb-moderator — engine & protocol spec

Version: 0.1 (solo mode). The room protocol (v1) extends these same
events over WebSocket; the engine is identical in a browser tab and in
the room server.

## Design rules

- **The engine is a pure, event-sourced reducer.** No I/O, no clocks, no
  randomness: every event carries the data it needs (timestamps,
  positions). State is fully serializable; **scores are derived from the
  event log**, never stored — so host corrections are just log edits and
  the scoreboard can always be recomputed.
- **Positions are abstract unit indexes** (a "unit" is one reveal token —
  see Reveal units below). The engine never sees question text; the
  caller resolves text/audio time → unit index. This is what lets the
  same engine adjudicate powers from a text clock (rooms) or an audio
  clock via qb-audio sidecars (read-aloud).
- **Every automatic verdict is a suggestion.** The host can override any
  verdict and edit any score line; the human-manned mode simply makes
  host input the only verdict source.

## Scoring config

```js
{
  scoring: true,            // false = scoreless (buzz order + reveal only)
  points: {
    power: 15,              // correct before the power mark
    get: 10,                // correct after the power mark
    neg: -5,                // wrong while still reading; after reading: 0
    superpower: null,       // e.g. 20 for sets with (+) marks; null = off
    bonusPart: 10,
  },
  pointPad: [15, 10, -5],   // host quick-award buttons (voice mode's
                            // primary scoring path); +20 appended when
                            // superpower is enabled; any values allowed
  humanJudge: false,        // true = no auto-checker; host adjudicates
}
```

Rule table (applied on VERDICT, using the buzz's unit index):

| Condition | Points |
|---|---|
| correct ∧ `unitIdx < superpowerIdx` (if enabled) | `points.superpower` |
| correct ∧ `unitIdx < powerIdx` | `points.power` |
| correct (otherwise) | `points.get` |
| wrong ∧ reading not finished | `points.neg` + lockout |
| wrong ∧ reading finished | 0 + lockout |

With `scoring: false` the same transitions happen with 0-point log
entries (buzz order, lockouts, and history still work).

## Engine events

| Event | Payload | Effect |
|---|---|---|
| `question_start` | `{qid, powerIdx, superpowerIdx, unitCount}` | phase → `reading`, clears buzz state |
| `reading_finished` | `{}` | closes the neg window (phase stays askable) |
| `buzz` | `{player, unitIdx, ts}` | first non-locked-out player wins: phase → `buzzed`, reading pauses |
| `verdict` | `{result: 'correct'\|'wrong', source: 'checker'\|'host', answer?, points?}` | scores per rule table — `points` overrides it (the host point pad in voice/manual-read mode, where position is unknown); correct → phase `done`; wrong → lockout, phase → `reading` (resume) or `dead` if everyone is locked out and reading finished |
| `award` | `{player, points, reason}` | direct score line (host point pad, bonus parts, corrections) |
| `dead` | `{}` | give up on the question: phase → `done`, no score |
| `next` | `{}` | ready for the next `question_start` |
| `override` | `{entryIdx, points}` | edits a past log entry (scores recompute) |
| `player_join` / `player_leave` | `{player, team?}` | roster; team is optional |
| `player_move` | `{player, team?, before?}` | reassign team and/or reorder: re-inserted before `before` (or at the end); `team` omitted = keep (pure reorder) |
| `configure` | `{patch}` | live settings change: merges scoring/points/humanJudge; pointPad re-derives from new points unless the patch pins one; the log is untouched |

State shape: `{config, players[], teams: {player: teamName|null}, phase,
current: {qid, powerIdx, superpowerIdx, unitCount, readingFinished,
buzz: {player, unitIdx} | null, lockouts: []}, log: [{qid, player,
points, kind, unitIdx, ts}]}`. `scores(state)` / `teamScores(state)` are
selectors over `log`. **Teams**: a wrong buzz locks out the buzzer's
whole team (standard rules); unassigned players lock out individually;
the question deads when every player is locked after reading finishes.

## Reading modes (app-level; the engine only sees events)

- `audio` — qb-audio TTS; question text AND answer hidden until the
  question ends, so the host can play. Position from the audio clock via
  sidecars. Falls back to `reveal` when a qid has no audio (never to
  full text — no spoilers).
- `reveal` — reader-contract word-by-word reveal (wpm + slow note-run
  spans); host can play; answer hidden until done.
- `text` — full text + answer always visible: the host is the moderator
  and reads aloud themselves. Position unknown (`unitIdx: null`).

Bonuses are an app-level toggle (engine-wise they're `award` events).
The roster UI exposes per-player point buttons (pointPad + 0): during
reading they capture buzz + verdict in one tap; otherwise they're direct
`award` adjustments.

## Reveal units (shared contract with the reader)

A question's text splits into reveal units exactly as `reader.js
buildUnits` does (whitespace tokens; dash-joined note runs split; the
power mark `(*)` is its own unit). `powerIdx` = index of the `(*)` unit
(absent → no powers). Audio mode maps `currentTime` through the qb-audio
sidecar (`{qid}.json` chunk spans → chunk text word offsets) to the same
unit indexes; files without sidecars fall back to proportional
`currentTime/duration`.

## Data contracts consumed (all plain HTTP)

- **Questions**: the site's R2 data plane — `catalog.json`
  (`sets: [{slug, name, year, difficulty, standard}]`) and
  `sets/{slug}.json` (`{packets: [{number, name, tossups, bonuses}]}`,
  API-shaped docs).
- **Audio**: the qb-audio dataset — `audio_index.json` manifest,
  `tossups/{qid[:2]}/{qid}.opus`, `{qid}.json` sidecars.
- **Answer checking**: qbreader's qb-answer-checker, vendored
  (`app/vendor/answer_checker.js`, ISC, unmodified from the site's vendor
  copy) — verdicts are suggestions for the host.

## Room protocol (v1, not yet built)

The engine moves server-side into a Durable Object per room
(architecture: library-of-stock `docs/rooms.md`). Client→server messages
are exactly the engine events above plus lobby concerns (join/name);
server→client is `{state, logTail}` snapshots + the reading clock
`{doc, startedAt, msPerWord}`. Buzz anti-cheat: server clamps the claimed
`unitIdx` against its own clock. Hosts self-host the room server
(wrangler deploy, free plan) or use the default instance.

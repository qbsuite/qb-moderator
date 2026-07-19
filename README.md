# qb-moderator

A quizbowl moderator tool: reads packets aloud (or lets you read from
the screen), takes buzzes, adjudicates answers, and keeps score with
real quizbowl rules — powers before the `(*)` mark, negs only while the
question is still being read.

Part of the [qbsuite](https://github.com/qbsuite) collection. Design:
`SPEC.md` in this repo.

## Status: v0 — solo host console

One device, one host. Working today:

- Pick any of ~700 mirrored sets → packet → read it in order, with
  tossup/bonus cycle.
- **Read-aloud** via the [qb-audio](https://huggingface.co/datasets/uild42/qb-audio)
  TTS dataset (where coverage exists — the dataset is still generating),
  with buzz position mapped through the chunk-offset sidecars so powers
  adjudicate from the audio clock; or **manual read** from the screen.
- Big mobile-friendly **BUZZ** button (or spacebar) → pick who buzzed →
  verdict. Typing what the player said gets a suggested verdict from
  qbreader's answer checker (vendored, ISC) — the host always has the
  final say.
- **Point pad** (+15 / +10 / −5, +20 when superpowers are enabled, 0):
  host-assigned points that also drive the game flow — the scoring path
  for voice mode and manual reading, where the app can't know the buzz
  position.
- Scoreless mode, lockouts, dead questions, score history with
  host overrides.

Roadmap (SPEC.md + the design doc): temporary self-hosted **rooms** with
phones as buzzers, then **voice mode** (physical-buzzer sound detection +
speech-to-text answers).

## Run it

Static files, no build. Serve the repo root and open `/app/`:

```
npx serve .        # or: python -m http.server
```

The app consumes two public HTTP data planes — no keys, no backend:
question text from the library-of-stock R2 bucket (`catalog.json`,
`sets/{slug}.json`) and audio from the qb-audio HF dataset.

## Develop

- `engine/engine.js` — the pure, event-sourced game engine (see SPEC.md).
  All rules live here; the app is data loading + DOM.
- `node --test tests/*.test.mjs` — engine rule vectors + the
  audio-clock→position mapper.
- `app/vendor/` — vendored code with provenance headers: qbreader's
  answer checker (ISC) and the reveal-unit splitter shared with the
  library-of-stock reader (must stay identical; see file header).

## Credits

Question content reaches this tool via [qbreader](https://www.qbreader.org)
and the tournament authors whose packets it archives. Answer checking is
[qb-answer-checker](https://github.com/qbreader/qb-answer-checker)
(ISC © Geoffrey Wu), vendored with attribution. MIT license.

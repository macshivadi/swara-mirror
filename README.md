# ஸ்வர கண்ணாடி · Swara Mirror

A one-page web app: sing into your microphone and watch Carnatic swara notation appear live.

Pitch detection runs entirely in the browser (Web Audio API + the YIN algorithm). Your voice never leaves the device. There is no server and no AI.

**Live:** https://macshivadi.github.io/swara-mirror/

## How to use

1. Tap **Tap to sing** and allow the microphone.
2. Sing. Notation appears as you hold a note. If you haven’t set Sa, the first steady note becomes Sa (or it keeps C# until then) — listening never stops in between.
3. A live timer, level meter, and “too quiet — move closer” hint show that the mic is still running. Tap **Stop** when you are done.
4. Copy, play, step through, or download the notation. Sa, skill level, and **Set my Sa** live under **Settings**.

Swara labels use the common 12-semitone mapping relative to your Sa: S, R₁, R₂, G₂, G₃, M₁, M₂, P, D₁, D₂, N₂, N₃. A dot below is mandra; a dot above is tara. Beginner, Intermediate, and Advanced change how tightly notes snap and how long a note must be held. Beginner starts with Forgiving pitch on, so short slides are ignored and wobble is smoothed. Whistled notes (around 1–3 kHz) are detected automatically and shown on the keyboard in the same octave as your Sa.

Mid-phrase gamakas are smoothed so the written line doesn’t jitter on every oscillation. Fine raga detail is not annotated.

## Develop

```bash
npm install
npm test
npm run typecheck
npm run dev
```

The dev and preview servers use the GitHub Pages base path `/swara-mirror/`.

`window.__swaraMirror` is a small test hook (set Sa, inject a frequency or play a silent oscillator, read the current swara and notation).

## Deploy

Pushes to `main` run tests, typecheck, and build, then publish `dist/` to GitHub Pages via GitHub Actions.

## Offline accuracy

`npm run eval:singing` runs the same pitch pipeline against the [vocadito](https://zenodo.org/records/5578807) solo-vocal set (CC BY 4.0). Download and extract it to `eval/data/` (gitignored). Results are summarized in `eval/RESULTS.md`. Audio is not committed.

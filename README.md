# ஸ்வர கண்ணாடி · Swara Mirror

A one-page web app: sing into your microphone and watch Carnatic swara notation appear live.

Pitch detection runs entirely in the browser (Web Audio API + the YIN algorithm). Your voice never leaves the device. There is no server and no AI.

**Live:** https://macshivadi.github.io/swara-mirror/

## How to use

1. Pick your Sa from the list, or tap **Set my Sa** and sing a steady note for about 1½ seconds.
2. Tap **Start listening** and allow the microphone.
3. Sing (your voice alone works best — a backing track will confuse the detector).
4. Stable swaras collect in the notation strip. Copy, clear, or play them back as sine tones.

Swara labels use the common 12-semitone mapping relative to your Sa: S, R₁, R₂, G₂, G₃, M₁, M₂, P, D₁, D₂, N₂, N₃. A dot below is mandra; a dot above is tara. A cents needle shows how sharp or flat you are of the nearest swara.

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

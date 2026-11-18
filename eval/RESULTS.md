# Singing accuracy (offline harness)

Evaluated 40 solo-vocal excerpts from **vocadito** (Bittner, Pasalo, Bosch, Meseguer Brocal, and Rubinstein, [Zenodo 5578807](https://zenodo.org/records/5578807), **CC BY 4.0**) through the same in-app pipeline: YIN, RMS gate, makeup gain, octave stabilizer, swara hysteresis, and the notation collector. The hop is `sampleRate/60` to approximate the live rAF cadence; it is not a recorded browser clock.

Sa for each track is the duration-weighted most common pitch class in annotator-1 note labels (median Hz of that class). That is a shared reference so predicted and ground-truth swaras line up — it is not a claim that we recovered the musical tonic.

Audio was **not** committed; only this report and the harness were.

## Mean results

| Metric | Vocadito (40 tracks) |
| --- | ---: |
| Frame swara pitch-class accuracy | 71.2% |
| Frame swara + octave accuracy | 69.2% |
| Octave-error rate (given correct class) | 2.8% |
| Median |cents| vs F0 (octave-corrected) | 20.8 |
| Frames within 50 cents | 79.4% |
| Frames within 100 cents | 92.7% |
| Note-sequence normalized edit distance (pitch class) | 0.38 |
| Same, octave-aware tokens | 0.40 |
| Annotator A1 vs A2 sequence ND (ceiling) | 0.15 |
| Mean spurious notes / track | 1.3 |
| Mean missed notes / track | 9.4 |
| “Set my Sa” success on first 4 s | 67.5% |
| …and within 100 cents of opening F0 | 37.5% |

## How to read this

- Frame scores compare our pitch to vocadito’s frame-level F0 on frames where both are voiced. Vibrato, slides and consonant onsets remain hard; 12-TET swara bins will disagree with a sung note that sits between shrutis.
- Sequence scores compare compacted notation (notes shorter than the app’s 180 ms hold are dropped, consecutive repeats merged). A normalized edit distance of 0 is a perfect token string; 1 means every token was wrong or missing. Annotator A1 vs A2 is a rough human ceiling.
- Calibration uses the same `evaluateCalibration` helper as the live “Set my Sa” button, on the first 4 s of each excerpt (these are songs, not held Sa drills, so failure is expected on some tracks).
- Synthetic sung scales (unit tests) are a separate, easier level: clean and vibrato-plus-noise S–R2–G3–P–S′ recover the exact sequence.

## Sources

- vocadito: Bittner, R., Pasalo, K., Bosch, J. J., Meseguer Brocal, G., & Rubinstein, D. (2021). vocadito: A dataset of solo vocals with f0, note, and lyric annotations. Zenodo. https://doi.org/10.5281/zenodo.5578807. CC BY 4.0.
- Harness: `npx vite-node scripts/eval-singing.ts` (requires the dataset under `eval/data/`, gitignored).

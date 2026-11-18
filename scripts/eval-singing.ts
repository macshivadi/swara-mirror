/**
 * Offline accuracy harness for the same pipeline the live app uses.
 *
 * Usage: npx vite-node scripts/eval-singing.ts
 * Expects Vocadito (CC BY 4.0) extracted at eval/data/ (gitignored).
 *
 * Dataset: Bittner, Pasalo, Bosch, Meseguer Brocal, and Rubinstein, vocadito, Zenodo 5578807, CC BY 4.0.
 * https://zenodo.org/records/5578807
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { evaluateCalibration, type CalibrateSample } from '../src/music/calibrate';
import { compactSwaraSequence, type NotationEvent } from '../src/music/notation';
import { formatSwaraAscii, hzToSwara, hzToWesternNote, midiToHz, type SwaraName } from '../src/music/swara';
import { AUDIO_SETTINGS as S } from '../src/audio/settings';
import { runPipeline, type PipelineResult } from '../src/eval/pipeline';
import { readWavFile } from './wav';

const ROOT = join(import.meta.dirname, '..');
const DATA = join(ROOT, 'eval', 'data');
const AUDIO = join(DATA, 'Audio');
const NOTES = join(DATA, 'Annotations', 'Notes');
const F0 = join(DATA, 'Annotations', 'F0');
const MIN_NOTE_MS = S.notationHoldMs;

interface GtNote {
  startMs: number;
  endMs: number;
  hz: number;
  swara: SwaraName;
  octave: number;
  token: string;
}

interface TrackScore {
  id: string;
  saHz: number;
  saNote: string;
  durationSec: number;
  gtNotes: number;
  predNotes: number;
  frameBothVoiced: number;
  framePredVoiced: number;
  frameGtVoiced: number;
  centsMedian: number | null;
  within50: number | null;
  within100: number | null;
  swaraClassAcc: number | null;
  swaraOctaveAcc: number | null;
  octaveErrorRate: number | null;
  seqClassNormEd: number | null;
  seqOctaveNormEd: number | null;
  spurious: number;
  missed: number;
  a1a2ClassNormEd: number | null;
  calibration: {
    ok: boolean;
    reason: string;
    snappedNote: string | null;
    centsFromOpening: number | null;
  };
}

function parseNotes(path: string, saHz: number): GtNote[] {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => {
    const [start, hz, dur] = line.split(/[,\s]+/).map(Number);
    const startMs = (start ?? 0) * 1000;
    const durationMs = (dur ?? 0) * 1000;
    const pitch = hzToSwara(hz ?? 0, saHz);
    return {
      startMs,
      endMs: startMs + durationMs,
      hz: hz ?? 0,
      swara: pitch.swara,
      octave: pitch.octave,
      token: formatSwaraAscii(pitch.swara, pitch.octave),
    };
  });
}

function parseF0(path: string): { timeMs: number; hz: number }[] {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => {
    const [t, hz] = line.split(/[,\s]+/).map(Number);
    return { timeMs: (t ?? 0) * 1000, hz: hz ?? 0 };
  });
}

function mostCommonPitchClassSa(notes: { hz: number; startMs: number; endMs: number }[]): number {
  const buckets = new Map<number, { dur: number; hzs: number[] }>();
  for (const n of notes) {
    if (!(n.hz > 0)) continue;
    const midi = 69 + 12 * Math.log2(n.hz / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const cur = buckets.get(pc) ?? { dur: 0, hzs: [] };
    cur.dur += Math.max(0, n.endMs - n.startMs);
    cur.hzs.push(n.hz);
    buckets.set(pc, cur);
  }
  let best: { dur: number; hzs: number[] } | null = null;
  for (const b of buckets.values()) {
    if (!best || b.dur > best.dur) best = b;
  }
  if (!best || best.hzs.length === 0) return midiToHz(60);
  const folded = best.hzs.map((hz) => {
    let f = hz;
    const target = best!.hzs[0]!;
    while (f > target * Math.SQRT2) f /= 2;
    while (f < target / Math.SQRT2) f *= 2;
    return f;
  });
  const mid = [...folded].sort((a, b) => a - b)[Math.floor(folded.length / 2)]!;
  return mid;
}

function sequenceOf(notes: { token: string; startMs: number; endMs: number; swara: SwaraName }[], classOnly = false): string[] {
  const toks: string[] = [];
  for (const n of notes) {
    if (n.endMs - n.startMs < MIN_NOTE_MS) continue;
    const tok = classOnly ? n.swara : n.token;
    if (toks[toks.length - 1] !== tok) toks.push(tok);
  }
  return toks;
}

function predNotesFromEvents(events: readonly NotationEvent[]): { token: string; startMs: number; endMs: number; swara: SwaraName }[] {
  return events
    .filter((e): e is Extract<NotationEvent, { type: 'note' }> => e.type === 'note')
    .map((e) => ({
      token: formatSwaraAscii(e.swara, e.octave),
      swara: e.swara,
      startMs: e.startMs,
      endMs: e.startMs + e.durationMs,
    }));
}

function levenshtein(a: string[], b: string[]): { distance: number; ins: number; del: number; sub: number } {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  const op: string[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(''));
  for (let i = 0; i <= m; i++) {
    dp[i]![0] = i;
    op[i]![0] = 'd';
  }
  for (let j = 0; j <= n; j++) {
    dp[0]![j] = j;
    op[0]![j] = 'i';
  }
  op[0]![0] = 'k';
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
        op[i]![j] = 'k';
      } else {
        const sub = dp[i - 1]![j - 1]! + 1;
        const del = dp[i - 1]![j]! + 1;
        const ins = dp[i]![j - 1]! + 1;
        const best = Math.min(sub, del, ins);
        dp[i]![j] = best;
        op[i]![j] = best === sub ? 's' : best === del ? 'd' : 'i';
      }
    }
  }
  let i = m;
  let j = n;
  let ins = 0;
  let del = 0;
  let sub = 0;
  while (i > 0 || j > 0) {
    const o = op[i]![j]!;
    if (o === 'k') {
      i--;
      j--;
    } else if (o === 's') {
      sub++;
      i--;
      j--;
    } else if (o === 'd') {
      del++;
      i--;
    } else {
      ins++;
      j--;
    }
  }
  return { distance: dp[m]![n]!, ins, del, sub };
}

function normEd(a: string[], b: string[]): number | null {
  if (a.length === 0 && b.length === 0) return 0;
  const { distance } = levenshtein(a, b);
  return distance / Math.max(a.length, b.length, 1);
}

function f0At(f0: { timeMs: number; hz: number }[], timeMs: number): number {
  if (f0.length === 0) return 0;
  let lo = 0;
  let hi = f0.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (f0[mid]!.timeMs > timeMs) hi = mid - 1;
    else lo = mid;
  }
  return f0[lo]!.hz;
}

function scoreTrack(id: string, audioPath: string): TrackScore {
  const wav = readWavFile(audioPath);
  const rawA1 = parseNotes(join(NOTES, `vocadito_${id}_notesA1.csv`), 440).map((n) => ({
    hz: n.hz,
    startMs: n.startMs,
    endMs: n.endMs,
  }));
  const saHz = mostCommonPitchClassSa(rawA1);
  const saNote = hzToWesternNote(saHz).note;
  const a1 = parseNotes(join(NOTES, `vocadito_${id}_notesA1.csv`), saHz);
  const a2 = parseNotes(join(NOTES, `vocadito_${id}_notesA2.csv`), saHz);
  const f0 = parseF0(join(F0, `vocadito_${id}_f0.csv`));
  const pipeline = runPipeline(wav.samples, wav.sampleRate, { saHz });

  const cents: number[] = [];
  let both = 0;
  let predV = 0;
  let gtV = 0;
  let classHit = 0;
  let octHit = 0;
  let classHitOctWrong = 0;
  let fi = 0;
  for (const fr of pipeline.frames) {
    if (fr.frequency) predV++;
    while (fi + 1 < f0.length && f0[fi + 1]!.timeMs <= fr.timeMs) fi++;
    const gtHz = f0[fi]?.hz ?? 0;
    if (gtHz > 0) gtV++;
    if (gtHz > 0 && fr.frequency) {
      both++;
      const c = Math.abs(1200 * Math.log2(fr.frequency / gtHz));
      const cOct = Math.min(c, Math.abs(c - 1200), Math.abs(c - 2400));
      cents.push(cOct);
      const gtP = hzToSwara(gtHz, saHz);
      const prP = hzToSwara(fr.frequency, saHz);
      if (gtP.swara === prP.swara) {
        classHit++;
        if (gtP.octave === prP.octave) octHit++;
        else classHitOctWrong++;
      }
    }
  }
  cents.sort((a, b) => a - b);
  const medianCents = cents.length ? cents[Math.floor(cents.length / 2)]! : null;

  const pred = predNotesFromEvents(pipeline.events);
  const gtSeqC = sequenceOf(a1, true);
  const prSeqC = sequenceOf(pred, true);
  const gtSeqO = sequenceOf(a1, false);
  const prSeqO = sequenceOf(pred, false);
  const a2SeqC = sequenceOf(a2, true);

  let spurious = 0;
  for (const p of pred) {
    if (p.endMs - p.startMs < MIN_NOTE_MS) {
      spurious++;
      continue;
    }
    const overlap = a1.some(
      (g) => g.swara === p.swara && Math.min(g.endMs, p.endMs) - Math.max(g.startMs, p.startMs) > 40,
    );
    if (!overlap) spurious++;
  }
  let missed = 0;
  for (const g of a1) {
    if (g.endMs - g.startMs < MIN_NOTE_MS) continue;
    const overlap = pred.some(
      (p) => p.swara === g.swara && Math.min(g.endMs, p.endMs) - Math.max(g.startMs, p.startMs) > 40,
    );
    if (!overlap) missed++;
  }

  const opening = f0.filter((s) => s.timeMs <= 4000 && s.hz > 0);
  const openingHz = opening.length ? opening[Math.floor(opening.length / 2)]!.hz : null;
  const calSamples: CalibrateSample[] = pipeline.frames
    .filter((f) => f.timeMs <= 4000 && f.frequency)
    .map((f) => ({ timeMs: f.timeMs, frequency: f.frequency! }));
  const cal = evaluateCalibration(calSamples, 4000);
  const centsFromOpening =
    cal.ok && cal.snappedHz && openingHz ? 1200 * Math.log2(cal.snappedHz / openingHz) : null;

  return {
    id,
    saHz,
    saNote,
    durationSec: wav.samples.length / wav.sampleRate,
    gtNotes: a1.filter((n) => n.endMs - n.startMs >= MIN_NOTE_MS).length,
    predNotes: pred.length,
    frameBothVoiced: both,
    framePredVoiced: predV,
    frameGtVoiced: gtV,
    centsMedian: medianCents,
    within50: cents.length ? cents.filter((c) => c <= 50).length / cents.length : null,
    within100: cents.length ? cents.filter((c) => c <= 100).length / cents.length : null,
    swaraClassAcc: both ? classHit / both : null,
    swaraOctaveAcc: both ? octHit / both : null,
    octaveErrorRate: classHit ? classHitOctWrong / classHit : null,
    seqClassNormEd: normEd(gtSeqC, prSeqC),
    seqOctaveNormEd: normEd(gtSeqO, prSeqO),
    spurious,
    missed,
    a1a2ClassNormEd: normEd(gtSeqC, a2SeqC),
    calibration: {
      ok: cal.ok,
      reason: cal.reason,
      snappedNote: cal.snappedNote,
      centsFromOpening,
    },
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  if (!existsSync(AUDIO)) {
    console.error(`Vocadito audio not found at ${AUDIO}.`);
    console.error('Download CC BY 4.0 zip from https://zenodo.org/records/5578807 and extract into eval/data/');
    process.exit(2);
  }
  const ids = readdirSync(AUDIO)
    .map((f) => basename(f).match(/^vocadito_(\d+)\.wav$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => m[1]!)
    .sort((a, b) => Number(a) - Number(b));

  console.log(`Evaluating ${ids.length} vocadito tracks through the app pipeline…`);
  const scores: TrackScore[] = [];
  for (const id of ids) {
    const s = scoreTrack(id, join(AUDIO, `vocadito_${id}.wav`));
    scores.push(s);
    const acc = s.swaraClassAcc !== null ? pct(s.swaraClassAcc) : 'n/a';
    console.log(
      `  #${id.padStart(2, ' ')} sa~${s.saNote}  class ${acc}  oct-err ${s.octaveErrorRate !== null ? pct(s.octaveErrorRate) : 'n/a'}  seqED ${s.seqClassNormEd?.toFixed(2)}  cal ${s.calibration.ok ? s.calibration.snappedNote : s.calibration.reason}`,
    );
  }

  const classAcc = scores.map((s) => s.swaraClassAcc).filter((x): x is number => x !== null);
  const octAcc = scores.map((s) => s.swaraOctaveAcc).filter((x): x is number => x !== null);
  const octErr = scores.map((s) => s.octaveErrorRate).filter((x): x is number => x !== null);
  const within50 = scores.map((s) => s.within50).filter((x): x is number => x !== null);
  const within100 = scores.map((s) => s.within100).filter((x): x is number => x !== null);
  const centsMed = scores.map((s) => s.centsMedian).filter((x): x is number => x !== null);
  const seqC = scores.map((s) => s.seqClassNormEd).filter((x): x is number => x !== null);
  const seqO = scores.map((s) => s.seqOctaveNormEd).filter((x): x is number => x !== null);
  const a1a2 = scores.map((s) => s.a1a2ClassNormEd).filter((x): x is number => x !== null);
  const calOk = scores.filter((s) => s.calibration.ok).length;
  const calClose = scores.filter((s) => s.calibration.ok && s.calibration.centsFromOpening !== null && Math.abs(s.calibration.centsFromOpening) <= 100).length;

  const summary = {
    dataset: 'vocadito (Bittner, Pasalo, Bosch, Meseguer Brocal, and Rubinstein, Zenodo 5578807, CC BY 4.0, https://doi.org/10.5281/zenodo.5578807)',
    tracks: scores.length,
    saEstimate: 'Duration-weighted most common pitch class of annotator-1 notes; Sa Hz is the median of that class. This is a shared reference, not a claimed musical tonic.',
    pipeline: {
      ...S,
      hop: 'sampleRate/60 to approximate the live rAF cadence',
      note: 'Same YIN window, thresholds, makeup gain, octave stabilizer, hysteresis and notation collector as the live app. Hop is rAF-like, not identical to a browser rAF clock.',
    },
    means: {
      frameSwaraClassAccuracy: mean(classAcc),
      frameSwaraOctaveAccuracy: mean(octAcc),
      octaveErrorRateGivenClass: mean(octErr),
      medianAbsCentsOctaveCorrected: mean(centsMed),
      within50Cents: mean(within50),
      within100Cents: mean(within100),
      sequenceClassNormEditDistance: mean(seqC),
      sequenceOctaveNormEditDistance: mean(seqO),
      annotatorA1A2ClassNormEditDistance: mean(a1a2),
      meanSpuriousNotes: mean(scores.map((s) => s.spurious)),
      meanMissedNotes: mean(scores.map((s) => s.missed)),
      calibrationSuccessRate: calOk / scores.length,
      calibrationWithin100CentsOfOpeningF0: calClose / scores.length,
    },
    tracks: scores,
  };

  writeFileSync(join(ROOT, 'eval', 'results.json'), JSON.stringify(summary, null, 2));

  const md = `# Singing accuracy (offline harness)

Evaluated ${scores.length} solo-vocal excerpts from **vocadito** (Bittner, Pasalo, Bosch, Meseguer Brocal, and Rubinstein, [Zenodo 5578807](https://zenodo.org/records/5578807), **CC BY 4.0**) through the same in-app pipeline: YIN, RMS gate, makeup gain, octave stabilizer, swara hysteresis, and the notation collector. The hop is \`sampleRate/60\` to approximate the live rAF cadence; it is not a recorded browser clock.

Sa for each track is the duration-weighted most common pitch class in annotator-1 note labels (median Hz of that class). That is a shared reference so predicted and ground-truth swaras line up — it is not a claim that we recovered the musical tonic.

Audio was **not** committed; only this report and the harness were.

## Mean results

| Metric | Vocadito (40 tracks) |
| --- | ---: |
| Frame swara pitch-class accuracy | ${pct(mean(classAcc))} |
| Frame swara + octave accuracy | ${pct(mean(octAcc))} |
| Octave-error rate (given correct class) | ${pct(mean(octErr))} |
| Median |cents| vs F0 (octave-corrected) | ${mean(centsMed).toFixed(1)} |
| Frames within 50 cents | ${pct(mean(within50))} |
| Frames within 100 cents | ${pct(mean(within100))} |
| Note-sequence normalized edit distance (pitch class) | ${mean(seqC).toFixed(2)} |
| Same, octave-aware tokens | ${mean(seqO).toFixed(2)} |
| Annotator A1 vs A2 sequence ND (ceiling) | ${mean(a1a2).toFixed(2)} |
| Mean spurious notes / track | ${mean(scores.map((s) => s.spurious)).toFixed(1)} |
| Mean missed notes / track | ${mean(scores.map((s) => s.missed)).toFixed(1)} |
| “Set my Sa” success on first 4 s | ${pct(calOk / scores.length)} |
| …and within 100 cents of opening F0 | ${pct(calClose / scores.length)} |

## How to read this

- Frame scores compare our pitch to vocadito’s frame-level F0 on frames where both are voiced. Vibrato, slides and consonant onsets remain hard; 12-TET swara bins will disagree with a sung note that sits between shrutis.
- Sequence scores compare compacted notation (notes shorter than the app’s ${MIN_NOTE_MS} ms hold are dropped, consecutive repeats merged). A normalized edit distance of 0 is a perfect token string; 1 means every token was wrong or missing. Annotator A1 vs A2 is a rough human ceiling.
- Calibration uses the same \`evaluateCalibration\` helper as the live “Set my Sa” button, on the first 4 s of each excerpt (these are songs, not held Sa drills, so failure is expected on some tracks).
- Synthetic sung scales (unit tests) are a separate, easier level: clean and vibrato-plus-noise S–R2–G3–P–S′ recover the exact sequence.

## Sources

- vocadito: Bittner, R., Pasalo, K., Bosch, J. J., Meseguer Brocal, G., & Rubinstein, D. (2021). vocadito: A dataset of solo vocals with f0, note, and lyric annotations. Zenodo. https://doi.org/10.5281/zenodo.5578807. CC BY 4.0.
- Harness: \`npx vite-node scripts/eval-singing.ts\` (requires the dataset under \`eval/data/\`, gitignored).
`;

  writeFileSync(join(ROOT, 'eval', 'RESULTS.md'), md);
  console.log('\n' + md);
  console.log('Wrote eval/RESULTS.md and eval/results.json');
}

main();

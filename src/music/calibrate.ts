import { foldCluster, median } from '../audio/octave';
import { hzToWesternNote, westernNoteToHz } from './swara';

export interface CalibrateSample {
  timeMs: number;
  frequency: number;
}

export interface CalibrateOptions {
  /** Accept once this much inlier voiced time is collected. */
  minVoicedMs?: number;
  /** Don't lock in before this much listening time. */
  minElapsedMs?: number;
  /** Preferred listening window. */
  targetMs?: number;
  /** Give up (or accept a slightly shorter inlier run) after this. */
  maxWaitMs?: number;
  /** Inliers are samples within this many cents of the median. */
  inlierCents?: number;
  /** At maxWait, accept if inliers reach this (slightly looser) floor. */
  maxWaitMinVoicedMs?: number;
}

export interface CalibrationResult {
  ok: boolean;
  reason: 'ready' | 'waiting' | 'too-short' | 'too-unsteady' | 'no-voicing';
  medianHz: number | null;
  snappedHz: number | null;
  snappedNote: string | null;
  snapCents: number | null;
  inlierMs: number;
  voicedMs: number;
  sampleCount: number;
  inlierCount: number;
  progress: number;
}

export const CALIBRATE_DEFAULTS = {
  minVoicedMs: 700,
  minElapsedMs: 1000,
  targetMs: 3000,
  maxWaitMs: 4000,
  inlierCents: 80,
  maxWaitMinVoicedMs: 600,
} as const;

export function evaluateCalibration(
  samples: readonly CalibrateSample[],
  elapsedMs: number,
  options: CalibrateOptions = {},
): CalibrationResult {
  const minVoicedMs = options.minVoicedMs ?? CALIBRATE_DEFAULTS.minVoicedMs;
  const minElapsedMs = options.minElapsedMs ?? CALIBRATE_DEFAULTS.minElapsedMs;
  const targetMs = options.targetMs ?? CALIBRATE_DEFAULTS.targetMs;
  const maxWaitMs = options.maxWaitMs ?? CALIBRATE_DEFAULTS.maxWaitMs;
  const inlierCents = options.inlierCents ?? CALIBRATE_DEFAULTS.inlierCents;
  const maxWaitMinVoicedMs = options.maxWaitMinVoicedMs ?? CALIBRATE_DEFAULTS.maxWaitMinVoicedMs;

  const empty: CalibrationResult = {
    ok: false,
    reason: 'waiting',
    medianHz: null,
    snappedHz: null,
    snappedNote: null,
    snapCents: null,
    inlierMs: 0,
    voicedMs: 0,
    sampleCount: samples.length,
    inlierCount: 0,
    progress: Math.max(0, Math.min(0.95, elapsedMs / targetMs)),
  };

  if (samples.length === 0) {
    if (elapsedMs >= maxWaitMs) return { ...empty, reason: 'no-voicing', progress: 1 };
    return empty;
  }

  const folded = foldCluster(samples.map((s) => s.frequency));
  const foldedSamples = samples.map((s, i) => ({ timeMs: s.timeMs, frequency: folded[i]! }));
  const voicedMs = spanDuration(foldedSamples);
  const mid = median(folded);
  const inliers = foldedSamples.filter((s) => Math.abs(1200 * Math.log2(s.frequency / mid)) <= inlierCents);
  const inlierMs = spanDuration(inliers);
  const { note, cents } = hzToWesternNote(mid);
  const snappedHz = westernNoteToHz(note);

  const progress = Math.max(
    Math.min(0.99, inlierMs / minVoicedMs),
    Math.min(0.99, elapsedMs / targetMs),
  );

  const base = {
    medianHz: mid,
    snappedHz,
    snappedNote: note,
    snapCents: cents,
    inlierMs,
    voicedMs,
    sampleCount: samples.length,
    inlierCount: inliers.length,
    progress,
  };

  const enough = inlierMs >= minVoicedMs && elapsedMs >= minElapsedMs;
  const lateOk = elapsedMs >= maxWaitMs && inlierMs >= maxWaitMinVoicedMs;

  if (enough || lateOk) {
    return { ...base, ok: true, reason: 'ready', progress: 1 };
  }

  if (elapsedMs >= maxWaitMs) {
    const reason = inlierMs < 200 && voicedMs < 250 ? 'no-voicing' : inlierMs < maxWaitMinVoicedMs ? 'too-short' : 'too-unsteady';
    return { ...base, ok: false, reason, progress: 1 };
  }

  return { ...base, ok: false, reason: 'waiting' };
}

export function calibrationErrorMessage(reason: CalibrationResult['reason']): string {
  switch (reason) {
    case 'no-voicing':
      return "Couldn't catch a steady note. Try a quiet room, sing a little louder, or pick a Sa from the list.";
    case 'too-short':
      return "Couldn't catch a long enough note. Hold your Sa for about a second, or pick a Sa from the list.";
    case 'too-unsteady':
      return 'The pitch moved around too much. Hold one note steadily, or pick a Sa from the list.';
    default:
      return "Couldn't catch a steady note. Try a quiet room, or pick a Sa from the list.";
  }
}

/** Duration covered by samples, counting gaps shorter than 80 ms. */
export function spanDuration(samples: readonly CalibrateSample[], maxGapMs = 80): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return 16;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]!.timeMs - samples[i - 1]!.timeMs;
    if (dt > 0 && dt <= maxGapMs) total += dt;
    else if (dt > maxGapMs) total += 16;
  }
  return total;
}

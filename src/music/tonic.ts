/**
 * Estimate a singer's Sa (tonic) from a stream of detected frequencies.
 * Uses a pitch-class histogram of stable frames, prefers a class that also
 * has a strong perfect fifth (Pa), and places the octave near the median
 * sung pitch, snapped to the nearest Western note.
 */
import { hzToMidi, hzToWesternNote, midiToHz, westernNoteToHz } from './swara';

export interface TonicEstimate {
  hz: number;
  note: string;
  medianHz: number;
  confidence: number;
  /** Duration weight per pitch class, C=0 … B=11. */
  pitchClassWeights: number[];
}

export interface EstimateTonicOptions {
  hopMs?: number;
  minHz?: number;
  maxHz?: number;
  /** Frames farther than this from the previous sample are treated as transitions. */
  stableCents?: number;
}

export function estimateTonicHz(
  frequencies: readonly (number | null | undefined)[],
  options: EstimateTonicOptions = {},
): TonicEstimate | null {
  const hopMs = options.hopMs ?? 1000 / 60;
  const minHz = options.minHz ?? 80;
  const maxHz = options.maxHz ?? 900;
  const stableCents = options.stableCents ?? 60;

  const pcs = new Array<number>(12).fill(0);
  const voiced: number[] = [];
  let prev: number | null = null;

  for (const f of frequencies) {
    if (f == null || !(f >= minHz) || f > maxHz) {
      prev = null;
      continue;
    }
    voiced.push(f);
    const stable = prev === null || Math.abs(1200 * Math.log2(f / prev)) < stableCents;
    prev = f;
    if (!stable) continue;
    const pc = ((Math.round(hzToMidi(f)) % 12) + 12) % 12;
    pcs[pc] = (pcs[pc] ?? 0) + hopMs;
  }

  if (voiced.length < 8) return null;

  let bestPc = 0;
  let bestScore = -1;
  for (let pc = 0; pc < 12; pc++) {
    const score = pcs[pc]! + 0.45 * pcs[(pc + 7) % 12]!;
    if (score > bestScore) {
      bestScore = score;
      bestPc = pc;
    }
  }

  const sorted = [...voiced].sort((a, b) => a - b);
  const medianHz = sorted[Math.floor(sorted.length / 2)]!;
  const medianMidi = hzToMidi(medianHz);
  let tonicMidi = bestPc + 12 * Math.round((medianMidi - bestPc) / 12);
  if (tonicMidi - medianMidi > 4) tonicMidi -= 12;
  if (medianMidi - tonicMidi > 12) tonicMidi += 12;

  const { note } = hzToWesternNote(midiToHz(tonicMidi));
  const hz = westernNoteToHz(note);
  const total = pcs.reduce((a, b) => a + b, 0);
  const confidence = total > 0 ? pcs[bestPc]! / total : 0;

  return { hz, note, medianHz, confidence, pitchClassWeights: pcs };
}

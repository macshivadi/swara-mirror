/** Time-domain level helpers used by the live tracker and the offline harness. */

export function rms(buffer: ArrayLike<number>): number {
  const n = buffer.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = buffer[i]!;
    sum += x * x;
  }
  return Math.sqrt(sum / n);
}

export function peakAbs(buffer: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]!);
    if (a > p) p = a;
  }
  return p;
}

/** Map RMS to a 0–1 meter. −60 dBFS is empty, −6 dBFS is full. */
export function rmsToMeter(rmsValue: number): number {
  const db = 20 * Math.log10(Math.max(rmsValue, 1e-7));
  return Math.max(0, Math.min(1, (db + 60) / 54));
}

/**
 * Copy `buffer` into `out` with a makeup gain so quiet-but-audible
 * takes still have enough amplitude for YIN, without clipping.
 */
export function applyMakeupGain(
  buffer: ArrayLike<number>,
  out: Float32Array,
  options: { targetRms?: number; maxGain?: number; floorRms?: number } = {},
): { gain: number; rms: number } {
  const targetRms = options.targetRms ?? 0.15;
  const maxGain = options.maxGain ?? 12;
  const floorRms = options.floorRms ?? 0.002;
  const level = rms(buffer);
  let gain = 1;
  if (level >= floorRms && level < targetRms) {
    gain = Math.min(maxGain, targetRms / level);
  }
  const n = Math.min(buffer.length, out.length);
  for (let i = 0; i < n; i++) {
    out[i] = buffer[i]! * gain;
  }
  return { gain, rms: level };
}

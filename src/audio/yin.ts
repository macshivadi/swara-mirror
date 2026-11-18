/**
 * YIN pitch detection (de Cheveigné & Kawahara, 2002).
 * Pure DSP — no I/O, safe to unit-test with synthetic sines.
 */
export interface YinOptions {
  /** Absolute threshold on the CMND function. Lower is stricter. Default 0.15. */
  threshold?: number;
  minHz?: number;
  maxHz?: number;
}

export interface YinResult {
  /** Detected fundamental frequency in Hz, or null if unvoiced. */
  frequency: number | null;
  /** Voicing probability in [0, 1], roughly 1 - yinValue at the chosen tau. */
  probability: number;
  /** Chosen lag in samples (fractional after interpolation). */
  tau: number | null;
}

const DEFAULT_THRESHOLD = 0.15;
const DEFAULT_MIN_HZ = 70;
const DEFAULT_MAX_HZ = 1200;

export function yinDetect(
  buffer: Float32Array,
  sampleRate: number,
  options: YinOptions = {},
): YinResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minHz = options.minHz ?? DEFAULT_MIN_HZ;
  const maxHz = options.maxHz ?? DEFAULT_MAX_HZ;

  const n = buffer.length;
  if (n < 32 || sampleRate <= 0) {
    return { frequency: null, probability: 0, tau: null };
  }

  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(n - 2, Math.floor(sampleRate / minHz));
  if (tauMin >= tauMax) {
    return { frequency: null, probability: 0, tau: null };
  }

  const diff = differenceFunction(buffer, tauMax);
  const cmnd = cumulativeMeanNormalizedDifference(diff, tauMax);

  const tauEstimate = absoluteThreshold(cmnd, tauMin, tauMax, threshold);
  if (tauEstimate === null) {
    const best = bestTau(cmnd, tauMin, tauMax);
    return { frequency: null, probability: best ? Math.max(0, 1 - cmnd[best]!) : 0, tau: null };
  }

  const tau = parabolicInterpolation(cmnd, tauEstimate);
  if (tau <= 0) {
    return { frequency: null, probability: 0, tau: null };
  }

  const frequency = sampleRate / tau;
  if (frequency < minHz || frequency > maxHz) {
    return { frequency: null, probability: 0, tau: null };
  }

  const yinValue = cmnd[tauEstimate] ?? 1;
  return {
    frequency,
    probability: Math.min(1, Math.max(0, 1 - yinValue)),
    tau,
  };
}

function differenceFunction(buffer: Float32Array, tauMax: number): Float32Array {
  const n = buffer.length;
  const diff = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    const limit = n - tau;
    for (let i = 0; i < limit; i++) {
      const delta = buffer[i]! - buffer[i + tau]!;
      sum += delta * delta;
    }
    diff[tau] = sum;
  }
  return diff;
}

function cumulativeMeanNormalizedDifference(diff: Float32Array, tauMax: number): Float32Array {
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau]!;
    cmnd[tau] = running > 0 ? (diff[tau]! * tau) / running : 1;
  }
  return cmnd;
}

function absoluteThreshold(
  cmnd: Float32Array,
  tauMin: number,
  tauMax: number,
  threshold: number,
): number | null {
  let tau = tauMin;
  while (tau < tauMax && cmnd[tau]! > threshold) {
    tau++;
  }
  if (tau === tauMax || cmnd[tau]! > threshold) {
    return null;
  }
  // Walk to the local minimum.
  while (tau + 1 <= tauMax && cmnd[tau + 1]! < cmnd[tau]!) {
    tau++;
  }
  return tau;
}

function bestTau(cmnd: Float32Array, tauMin: number, tauMax: number): number | null {
  let best = tauMin;
  let bestVal = cmnd[tauMin] ?? 1;
  for (let tau = tauMin + 1; tau <= tauMax; tau++) {
    const v = cmnd[tau]!;
    if (v < bestVal) {
      bestVal = v;
      best = tau;
    }
  }
  return best;
}

/** Refine an integer lag with a parabolic fit through cmnd[tau-1], [tau], [tau+1]. */
export function parabolicInterpolation(cmnd: Float32Array, tau: number): number {
  if (tau <= 0 || tau >= cmnd.length - 1) return tau;
  const s0 = cmnd[tau - 1]!;
  const s1 = cmnd[tau]!;
  const s2 = cmnd[tau + 1]!;
  const denom = 2 * (s0 - 2 * s1 + s2);
  if (denom === 0) return tau;
  const delta = (s0 - s2) / denom;
  if (!Number.isFinite(delta) || Math.abs(delta) >= 1) return tau;
  return tau + delta;
}

/** Generate a unit-ish sine buffer for tests and synthetic hooks. */
export function synthesizeSine(
  frequency: number,
  sampleRate: number,
  length: number,
  options: { amplitude?: number; phase?: number } = {},
): Float32Array {
  const amplitude = options.amplitude ?? 0.7;
  const phase = options.phase ?? 0;
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase);
  }
  return buf;
}


/** A sung-like tone: carrier + vibrato, optional noise, optional amplitude. */
export function synthesizeVoice(
  frequency: number,
  sampleRate: number,
  length: number,
  options: {
    amplitude?: number;
    vibratoHz?: number;
    vibratoCents?: number;
    noise?: number;
    seed?: number;
  } = {},
): Float32Array {
  const amplitude = options.amplitude ?? 0.35;
  const vibratoHz = options.vibratoHz ?? 0;
  const vibratoCents = options.vibratoCents ?? 0;
  const noise = options.noise ?? 0;
  let seed = options.seed ?? 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const buf = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const cents = vibratoCents * Math.sin(2 * Math.PI * vibratoHz * t);
    const inst = frequency * 2 ** (cents / 1200);
    phase += (2 * Math.PI * inst) / sampleRate;
    const n = noise > 0 ? (rand() * 2 - 1) * noise : 0;
    buf[i] = amplitude * Math.sin(phase) + n;
  }
  return buf;
}

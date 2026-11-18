import type { NotationEvent } from '../music/notation';
import { swaraToHz } from '../music/swara';

export interface PlaybackOptions {
  saHz: number;
  /** Default length for a note with unknown/very short duration. */
  beatMs?: number;
  onEvent?: (event: NotationEvent, index: number) => void;
}

/** Page-level playback level. Phone volume still controls the final loudness. */
export const PLAYBACK_MASTER_GAIN = 0.65;

/** Limiter settings applied after the master gain so chords don't clip. */
export const PLAYBACK_LIMITER = {
  threshold: -6,
  knee: 3,
  ratio: 20,
  attack: 0.003,
  release: 0.12,
} as const;

/**
 * Harmonium / tanpura-ish harmonic series (DC + partials 1–8).
 * Normalized by the AudioContext so a single note stays clean.
 */
export const PLAYBACK_HARMONICS = new Float32Array([0, 1, 0.45, 0.32, 0.18, 0.14, 0.08, 0.05, 0.03]);

export interface PlaybackOutput {
  master: GainNode;
  limiter: DynamicsCompressorNode;
}

const outputs = new WeakMap<AudioContext, PlaybackOutput>();
const timbres = new WeakMap<AudioContext, PeriodicWave>();

/**
 * Shared master gain → limiter → destination for a context.
 * One chain per context so the limiter sees the mix of overlapping notes.
 */
export function connectPlaybackOutput(ctx: AudioContext): PlaybackOutput {
  const existing = outputs.get(ctx);
  if (existing) return existing;

  const master = ctx.createGain();
  master.gain.value = PLAYBACK_MASTER_GAIN;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = PLAYBACK_LIMITER.threshold;
  limiter.knee.value = PLAYBACK_LIMITER.knee;
  limiter.ratio.value = PLAYBACK_LIMITER.ratio;
  limiter.attack.value = PLAYBACK_LIMITER.attack;
  limiter.release.value = PLAYBACK_LIMITER.release;

  master.connect(limiter);
  limiter.connect(ctx.destination);

  const chain = { master, limiter };
  outputs.set(ctx, chain);
  return chain;
}

export function createTimbreWave(ctx: AudioContext): PeriodicWave {
  const existing = timbres.get(ctx);
  if (existing) return existing;
  const imag = new Float32Array(PLAYBACK_HARMONICS.length);
  const wave = ctx.createPeriodicWave(PLAYBACK_HARMONICS, imag, { disableNormalization: false });
  timbres.set(ctx, wave);
  return wave;
}

/**
 * Play captured notation as short tones. Returns a stop function.
 * Must be called from a user-gesture stack so AudioContext can start on iOS.
 */
export async function playNotation(
  events: readonly NotationEvent[],
  ctx: AudioContext,
  options: PlaybackOptions,
): Promise<{ stopped: Promise<void>; stop: () => void }> {
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  const beatMs = options.beatMs ?? 320;
  const { master } = connectPlaybackOutput(ctx);
  const session = ctx.createGain();
  session.gain.value = 1;
  session.connect(master);

  let cancelled = false;
  let stopResolve: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      session.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    } catch {
      session.gain.value = 0;
    }
    setTimeout(() => {
      try {
        session.disconnect();
      } catch {
        /* already disconnected */
      }
      stopResolve();
    }, 80);
  };

  void (async () => {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (cancelled) break;
      options.onEvent?.(ev, i);
      if (ev.type === 'rest') {
        const wait = clamp(ev.durationMs, 120, 600);
        await sleep(wait);
        continue;
      }
      const freq = swaraToHz(ev.swara, ev.octave, options.saHz);
      const dur = clamp(ev.durationMs || beatMs, 160, 800);
      if (!cancelled) startTone(ctx, session, freq, dur / 1000);
      await sleep(dur + 30);
    }
    if (!cancelled) stop();
  })();

  return { stopped, stop };
}

export function startTone(ctx: AudioContext, dest: AudioNode, frequency: number, durationSec: number): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.setPeriodicWave(createTimbreWave(ctx));
  osc.frequency.value = frequency;
  const now = ctx.currentTime;
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(1, now + 0.018);
  env.gain.setValueAtTime(1, now + Math.max(0.04, durationSec - 0.05));
  env.gain.linearRampToValueAtTime(0, now + durationSec);
  osc.connect(env);
  env.connect(dest);
  osc.start(now);
  osc.stop(now + durationSec + 0.02);
  osc.onended = () => {
    try {
      osc.disconnect();
      env.disconnect();
    } catch {
      /* ignore */
    }
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Play a single tone. Must be called from a user-gesture stack on iOS. */
export async function playFreq(
  ctx: AudioContext,
  frequency: number,
  durationMs = 400,
): Promise<void> {
  if (ctx.state === 'suspended') await ctx.resume();
  const { master } = connectPlaybackOutput(ctx);
  startTone(ctx, master, frequency, durationMs / 1000);
  await new Promise((resolve) => setTimeout(resolve, durationMs + 40));
}

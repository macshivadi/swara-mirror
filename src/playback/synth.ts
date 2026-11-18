import type { NotationEvent } from '../music/notation';
import { swaraToHz } from '../music/swara';

export interface PlaybackOptions {
  saHz: number;
  /** Default length for a note with unknown/very short duration. */
  beatMs?: number;
  onEvent?: (event: NotationEvent, index: number) => void;
}

/**
 * Play captured notation as short sine tones. Returns a stop function.
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
  const master = ctx.createGain();
  master.gain.value = 0.18;
  master.connect(ctx.destination);

  let cancelled = false;
  let stopResolve: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    } catch {
      master.gain.value = 0;
    }
    setTimeout(() => {
      try {
        master.disconnect();
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
      if (!cancelled) startTone(ctx, master, freq, dur / 1000);
      await sleep(dur + 30);
    }
    if (!cancelled) stop();
  })();

  return { stopped, stop };
}

function startTone(ctx: AudioContext, dest: AudioNode, frequency: number, durationSec: number): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  const now = ctx.currentTime;
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(1, now + 0.015);
  env.gain.setValueAtTime(1, now + Math.max(0.03, durationSec - 0.05));
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
  gainValue = 0.18,
): Promise<void> {
  if (ctx.state === 'suspended') await ctx.resume();
  const master = ctx.createGain();
  master.gain.value = gainValue;
  master.connect(ctx.destination);
  startTone(ctx, master, frequency, durationMs / 1000);
  await new Promise((resolve) => setTimeout(resolve, durationMs + 40));
  try {
    master.disconnect();
  } catch {
    /* ignore */
  }
}

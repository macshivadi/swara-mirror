import { describe, expect, it } from 'vitest';
import {
  PLAYBACK_HARMONICS,
  PLAYBACK_LIMITER,
  PLAYBACK_MASTER_GAIN,
  connectPlaybackOutput,
  createTimbreWave,
  startTone,
} from './synth';

class FakeParam {
  value: number;
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
  setTargetAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode {
  readonly connections: FakeNode[] = [];
  connect(dest: FakeNode): FakeNode {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam(0);
  knee = new FakeParam(0);
  ratio = new FakeParam(0);
  attack = new FakeParam(0);
  release = new FakeParam(0);
}

class FakeOscillator extends FakeNode {
  type: OscillatorType = 'sine';
  frequency = new FakeParam(0);
  wave: FakePeriodicWave | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  setPeriodicWave(wave: FakePeriodicWave): void {
    this.wave = wave;
  }
  start(when?: number): void {
    this.startedAt = when ?? 0;
  }
  stop(when?: number): void {
    this.stoppedAt = when ?? 0;
  }
}

class FakePeriodicWave {
  constructor(
    readonly real: Float32Array,
    readonly imag: Float32Array,
    readonly constraints?: PeriodicWaveConstraints,
  ) {}
}

class FakeAudioContext {
  currentTime = 1;
  state: AudioContextState = 'running';
  destination = new FakeNode();
  gains: FakeGain[] = [];
  compressors: FakeCompressor[] = [];
  oscillators: FakeOscillator[] = [];
  waves: FakePeriodicWave[] = [];

  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createDynamicsCompressor(): FakeCompressor {
    const node = new FakeCompressor();
    this.compressors.push(node);
    return node;
  }

  createOscillator(): FakeOscillator {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }

  createPeriodicWave(
    real: Float32Array,
    imag: Float32Array,
    constraints?: PeriodicWaveConstraints,
  ): FakePeriodicWave {
    const wave = new FakePeriodicWave(real, imag, constraints);
    this.waves.push(wave);
    return wave;
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
}

function asCtx(ctx: FakeAudioContext): AudioContext {
  return ctx as unknown as AudioContext;
}

describe('playback output chain', () => {
  it('uses a louder master gain in the 0.6–0.7 range', () => {
    expect(PLAYBACK_MASTER_GAIN).toBeGreaterThanOrEqual(0.6);
    expect(PLAYBACK_MASTER_GAIN).toBeLessThanOrEqual(0.7);
  });

  it('wires master gain into a limiter, then the destination', () => {
    const ctx = new FakeAudioContext();
    const { master, limiter } = connectPlaybackOutput(asCtx(ctx));

    expect(master.gain.value).toBe(PLAYBACK_MASTER_GAIN);
    expect(limiter.threshold.value).toBe(PLAYBACK_LIMITER.threshold);
    expect(limiter.knee.value).toBe(PLAYBACK_LIMITER.knee);
    expect(limiter.ratio.value).toBe(PLAYBACK_LIMITER.ratio);
    expect(limiter.attack.value).toBe(PLAYBACK_LIMITER.attack);
    expect(limiter.release.value).toBe(PLAYBACK_LIMITER.release);
    expect(limiter.ratio.value).toBeGreaterThanOrEqual(12);
    expect(limiter.threshold.value).toBeLessThan(0);

    expect((master as unknown as FakeGain).connections).toContain(limiter);
    expect((limiter as unknown as FakeCompressor).connections).toContain(ctx.destination);
  });

  it('reuses one gain/compressor chain per context', () => {
    const ctx = new FakeAudioContext();
    const first = connectPlaybackOutput(asCtx(ctx));
    const second = connectPlaybackOutput(asCtx(ctx));
    expect(second).toBe(first);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.compressors).toHaveLength(1);
  });
});

describe('playback timbre', () => {
  it('builds a periodic wave with several harmonics above the fundamental', () => {
    expect(PLAYBACK_HARMONICS[0]).toBe(0);
    expect(PLAYBACK_HARMONICS[1]).toBe(1);
    const overtones = Array.from(PLAYBACK_HARMONICS.slice(2));
    expect(overtones.length).toBeGreaterThanOrEqual(4);
    expect(overtones.every((value) => value > 0)).toBe(true);
    expect(overtones.every((value) => value < 1)).toBe(true);
  });

  it('applies the custom wave to each tone and caches it per context', () => {
    const ctx = new FakeAudioContext();
    const dest = new FakeGain();
    startTone(asCtx(ctx), dest as unknown as AudioNode, 440, 0.2);
    startTone(asCtx(ctx), dest as unknown as AudioNode, 523.25, 0.2);

    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.waves).toHaveLength(1);
    expect(createTimbreWave(asCtx(ctx))).toBe(ctx.waves[0]);
    expect(ctx.oscillators[0]?.wave).toBe(ctx.waves[0]);
    expect(ctx.oscillators[1]?.wave).toBe(ctx.waves[0]);
    expect(ctx.oscillators[0]?.frequency.value).toBe(440);
    expect(ctx.oscillators[0]?.startedAt).toBe(1);
    expect(ctx.waves[0]?.constraints?.disableNormalization).toBe(false);
    expect(ctx.oscillators[0]?.connections[0]?.connections).toContain(dest);
  });
});

import { applyMakeupGain, rms, rmsToMeter } from './level';
import { OctaveStabilizer } from './octave';
import { AUDIO_SETTINGS as S } from './settings';
import { yinDetect } from './yin';

export type TrackerMode = 'listen' | 'calibrate';

export interface TrackerOptions {
  fftSize?: number;
  threshold?: number;
  minHz?: number;
  maxHz?: number;
  /** Probability below this is treated as unvoiced (listen mode). */
  minProbability?: number;
  calibrateThreshold?: number;
  calibrateMinProbability?: number;
  minRms?: number;
  calibrateMinRms?: number;
}

export interface TrackerReading {
  frequency: number | null;
  rawFrequency: number | null;
  probability: number;
  rms: number;
  level: number;
  timeMs: number;
}

const LISTEN = {
  threshold: S.listenThreshold,
  minProbability: S.listenMinProbability,
  minRms: S.listenMinRms,
} as const;

const CALIBRATE = {
  threshold: S.calibrateThreshold,
  minProbability: S.calibrateMinProbability,
  minRms: S.calibrateMinRms,
} as const;

/**
 * Microphone (or a test oscillator) → YIN, polled from rAF / a timer.
 * The raw audio never leaves the device.
 */
export class PitchTracker {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private inputGain: GainNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private work: Float32Array<ArrayBuffer> | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private testOsc: OscillatorNode | null = null;
  private testGain: GainNode | null = null;
  private injectedHz: number | null = null;
  private injectedRms = 0.2;
  private mode: TrackerMode = 'listen';
  private readonly octave = new OctaveStabilizer(S.octaveConfirmMs);
  private readonly opts: Required<TrackerOptions>;

  constructor(options: TrackerOptions = {}) {
    this.opts = {
      fftSize: options.fftSize ?? S.fftSize,
      threshold: options.threshold ?? LISTEN.threshold,
      minHz: options.minHz ?? S.minHz,
      maxHz: options.maxHz ?? S.maxHz,
      minProbability: options.minProbability ?? LISTEN.minProbability,
      calibrateThreshold: options.calibrateThreshold ?? CALIBRATE.threshold,
      calibrateMinProbability: options.calibrateMinProbability ?? CALIBRATE.minProbability,
      minRms: options.minRms ?? LISTEN.minRms,
      calibrateMinRms: options.calibrateMinRms ?? CALIBRATE.minRms,
    };
  }

  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  isMicLive(): boolean {
    return Boolean(this.micStream && this.micStream.getAudioTracks().some((t) => t.readyState === 'live'));
  }

  setMode(mode: TrackerMode): void {
    this.mode = mode;
  }

  getMode(): TrackerMode {
    return this.mode;
  }

  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.opts.fftSize;
      this.analyser.smoothingTimeConstant = 0;
      this.inputGain = this.ctx.createGain();
      this.inputGain.gain.value = S.inputGain;
      this.inputGain.connect(this.analyser);
      this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
      this.work = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  async startMic(): Promise<void> {
    const ctx = await this.ensureContext();
    if (this.isMicLive() && this.micSource) {
      if (ctx.state === 'suspended') await ctx.resume();
      return;
    }
    this.stopMic();
    const stream = await requestMicStream();
    if (ctx.state === 'suspended') await ctx.resume();
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.inputGain ?? this.analyser!);
    // iOS can suspend again after getUserMedia resolves.
    if (ctx.state === 'suspended') await ctx.resume();
  }

  stopMic(): void {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        /* ignore */
      }
      this.micSource = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
  }

  /**
   * Feed a known frequency into the analyser via an oscillator
   * (silent — not connected to the destination).
   */
  async startTestTone(hz: number): Promise<void> {
    const ctx = await this.ensureContext();
    this.stopTestTone();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.value = 0.8;
    osc.connect(gain);
    gain.connect(this.inputGain ?? this.analyser!);
    osc.start();
    this.testOsc = osc;
    this.testGain = gain;
  }

  setTestToneHz(hz: number): void {
    if (this.testOsc && this.ctx) {
      this.testOsc.frequency.setValueAtTime(hz, this.ctx.currentTime);
    }
  }

  stopTestTone(): void {
    if (this.testOsc) {
      try {
        this.testOsc.stop();
        this.testOsc.disconnect();
      } catch {
        /* ignore */
      }
      this.testOsc = null;
    }
    if (this.testGain) {
      try {
        this.testGain.disconnect();
      } catch {
        /* ignore */
      }
      this.testGain = null;
    }
  }

  /** Bypass DSP entirely — useful for deterministic unit-like UI hooks. */
  injectHz(hz: number | null, injectedRms = 0.2): void {
    this.injectedHz = hz;
    this.injectedRms = injectedRms;
  }

  read(nowMs: number = performance.now()): TrackerReading {
    if (this.injectedHz !== null) {
      const frequency = this.octave.update(nowMs, this.injectedHz);
      return {
        frequency,
        rawFrequency: this.injectedHz,
        probability: 1,
        rms: this.injectedRms,
        level: rmsToMeter(this.injectedRms),
        timeMs: nowMs,
      };
    }
    if (!this.analyser || !this.buffer || !this.work || !this.ctx) {
      return { frequency: null, rawFrequency: null, probability: 0, rms: 0, level: 0, timeMs: nowMs };
    }
    const buf = this.buffer;
    this.analyser.getFloatTimeDomainData(buf);
    const levelRms = rms(buf);
    const minRms = this.mode === 'calibrate' ? this.opts.calibrateMinRms : this.opts.minRms;
    if (levelRms < minRms) {
      this.octave.update(nowMs, null);
      return {
        frequency: null,
        rawFrequency: null,
        probability: 0,
        rms: levelRms,
        level: rmsToMeter(levelRms),
        timeMs: nowMs,
      };
    }

    applyMakeupGain(buf, this.work, { floorRms: minRms * 0.5, targetRms: S.makeupTargetRms, maxGain: S.makeupMaxGain });
    const threshold = this.mode === 'calibrate' ? this.opts.calibrateThreshold : this.opts.threshold;
    const minProbability =
      this.mode === 'calibrate' ? this.opts.calibrateMinProbability : this.opts.minProbability;
    const result = yinDetect(this.work, this.ctx.sampleRate, {
      threshold,
      minHz: this.opts.minHz,
      maxHz: this.opts.maxHz,
    });
    const raw = result.frequency !== null && result.probability >= minProbability ? result.frequency : null;
    const frequency = this.octave.update(nowMs, raw);
    return {
      frequency,
      rawFrequency: result.frequency,
      probability: result.probability,
      rms: levelRms,
      level: rmsToMeter(levelRms),
      timeMs: nowMs,
    };
  }

  resetStabilizer(): void {
    this.octave.reset();
  }

  async close(): Promise<void> {
    this.stopMic();
    this.stopTestTone();
    this.injectedHz = null;
    this.octave.reset();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
    this.analyser = null;
    this.inputGain = null;
    this.buffer = null;
    this.work = null;
  }
}

async function requestMicStream(): Promise<MediaStream> {
  const preferred: MediaStreamConstraints = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch {
    // Safari / some Android builds reject the boolean-false constraint set.
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

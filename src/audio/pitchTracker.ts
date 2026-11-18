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
  private silentGain: GainNode | null = null;
  private buffer: Float32Array | null = null;
  private work: Float32Array | null = null;
  private byteBuffer: Uint8Array | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private testOsc: OscillatorNode | null = null;
  private testGain: GainNode | null = null;
  private injectedHz: number | null = null;
  private injectedRms = 0.2;
  private mode: TrackerMode = 'listen';
  private wantMic = false;
  private recovering = false;
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

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  get contextState(): string {
    return this.ctx?.state ?? 'closed';
  }

  private micHeld = false;

  isMicLive(): boolean {
    return Boolean(this.micStream && this.micStream.getAudioTracks().some((t) => t.readyState === 'live'));
  }

  /** True while tracks are stopped so playback can leave iOS play-and-record mode. */
  isMicHeld(): boolean {
    return this.micHeld;
  }

  /**
   * Stop mic tracks without clearing the "keep listening" flag.
   * iOS stays in a call-style audio session while a live capture track exists,
   * which ducks playback; releasing the tracks lets piano/playback play louder.
   */
  pauseMic(): void {
    this.micHeld = true;
    this.releaseMicNodes();
  }

  /** Restart the mic after pauseMic(), if listening is still wanted. */
  async resumeMic(): Promise<void> {
    this.micHeld = false;
    if (this.wantMic) await this.startMic();
  }

  setMode(mode: TrackerMode): void {
    this.mode = mode;
  }

  getMode(): TrackerMode {
    return this.mode;
  }

  /**
   * Must run in the same synchronous turn as a user tap on iOS Safari.
   * Creates the context (if needed) and kicks off resume() before any await.
   */
  primeFromUserGesture(): AudioContext {
    const ctx = this.ensureContextSync();
    void this.resume();
    return ctx;
  }

  ensureContextSync(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // Do not pass sampleRate — iOS typically runs at 48 kHz and YIN uses ctx.sampleRate.
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.opts.fftSize;
      this.analyser.smoothingTimeConstant = 0;
      this.inputGain = this.ctx.createGain();
      this.inputGain.gain.value = S.inputGain;
      this.inputGain.connect(this.analyser);
      // Safari stops processing a graph that isn't connected to destination,
      // often after a second or two of apparent life.
      this.silentGain = this.ctx.createGain();
      this.silentGain.gain.value = 0;
      this.analyser.connect(this.silentGain);
      this.silentGain.connect(this.ctx.destination);
      this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
      this.work = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
      this.byteBuffer = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
      this.ctx.addEventListener('statechange', () => {
        if (this.needsResume() && (this.wantMic || this.testOsc)) void this.resume();
      });
    }
    if (this.needsResume()) void this.ctx.resume();
    return this.ctx;
  }

  async ensureContext(): Promise<AudioContext> {
    const ctx = this.ensureContextSync();
    await this.resume();
    return ctx;
  }

  async startMic(): Promise<void> {
    this.wantMic = true;
    const ctx = this.ensureContextSync();
    if (this.isMicLive() && this.micSource) {
      await this.resume();
      return;
    }
    this.releaseMicNodes();
    const stream = await requestMicStream();
    if (!this.wantMic) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    await this.resume();
    this.micStream = stream;
    for (const track of stream.getAudioTracks()) {
      track.enabled = true;
      this.watchTrack(track);
    }
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.inputGain ?? this.analyser!);
    // iOS often interrupts the context after the permission prompt.
    await this.resume();
  }

  /** Safe to call often; no-ops if the context is already running. */
  async resume(): Promise<void> {
    if (!this.ctx || this.ctx.state === 'closed') return;
    if (this.needsResume()) {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore — try again on the next tick or gesture */
      }
    }
  }

  private needsResume(): boolean {
    const state = this.ctx?.state as string | undefined;
    return state === 'suspended' || state === 'interrupted';
  }

  private watchTrack(track: MediaStreamTrack): void {
    track.addEventListener('ended', () => {
      if (this.wantMic) void this.recoverMic();
    });
    track.addEventListener('mute', () => {
      if (this.wantMic) void this.resume();
    });
    track.addEventListener('unmute', () => {
      if (!this.wantMic) return;
      track.enabled = true;
      void this.resume();
    });
  }

  private async recoverMic(): Promise<void> {
    if (!this.wantMic || this.recovering || this.micHeld) return;
    this.recovering = true;
    try {
      this.releaseMicNodes();
      await this.startMic();
    } catch {
      /* permission or device is gone; the UI keeps the timer running */
    } finally {
      this.recovering = false;
    }
  }

  /** Drop the current source/tracks without clearing the "keep listening" flag. */
  private releaseMicNodes(): void {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        /* ignore */
      }
      this.micSource = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      this.micStream = null;
    }
  }

  stopMic(): void {
    this.wantMic = false;
    this.micHeld = false;
    this.releaseMicNodes();
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
    if (this.needsResume()) void this.resume();
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
    this.fillTimeDomain(this.buffer);
    const levelRms = rms(this.buffer);
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

    applyMakeupGain(this.buffer, this.work, {
      floorRms: minRms * 0.5,
      targetRms: S.makeupTargetRms,
      maxGain: S.makeupMaxGain,
    });
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

  /**
   * Prefer getFloatTimeDomainData; fall back to the byte API used by older
   * WebKit, or when the float read comes back empty while the byte read has signal.
   */
  private fillTimeDomain(buf: Float32Array): void {
    const analyser = this.analyser!;
    let usedFloat = false;
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      try {
        analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
        usedFloat = true;
      } catch {
        usedFloat = false;
      }
    }
    if (usedFloat && hasSignal(buf)) return;
    if (!this.byteBuffer || typeof analyser.getByteTimeDomainData !== 'function') return;
    analyser.getByteTimeDomainData(this.byteBuffer as Uint8Array<ArrayBuffer>);
    if (usedFloat && !byteHasSignal(this.byteBuffer)) return;
    byteToFloatTimeDomain(this.byteBuffer, buf);
  }

  resetStabilizer(): void {
    this.octave.reset();
  }

  async close(): Promise<void> {
    this.stopMic();
    this.stopTestTone();
    this.injectedHz = null;
    this.octave.reset();
    if (this.ctx && this.ctx.state !== 'closed') {
      await this.ctx.close();
    }
    this.ctx = null;
    this.analyser = null;
    this.inputGain = null;
    this.silentGain = null;
    this.buffer = null;
    this.work = null;
    this.byteBuffer = null;
  }
}

export function byteToFloatTimeDomain(bytes: Uint8Array, out: Float32Array): void {
  const n = Math.min(bytes.length, out.length);
  for (let i = 0; i < n; i++) {
    out[i] = (bytes[i]! - 128) / 128;
  }
}

function hasSignal(buf: Float32Array): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (Math.abs(buf[i]!) > 1e-5) return true;
  }
  return false;
}

function byteHasSignal(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (Math.abs(bytes[i]! - 128) > 1) return true;
  }
  return false;
}

async function requestMicStream(): Promise<MediaStream> {
  const preferred: MediaStreamConstraints = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      // Phone mics are often too quiet with AGC off, so notes never trigger.
      autoGainControl: true,
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch {
    // Safari / some Android builds reject a strict constraint set.
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

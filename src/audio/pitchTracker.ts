import { yinDetect } from './yin';

export interface TrackerOptions {
  fftSize?: number;
  threshold?: number;
  minHz?: number;
  maxHz?: number;
  /** Probability below this is treated as unvoiced. */
  minProbability?: number;
}

export interface TrackerReading {
  frequency: number | null;
  probability: number;
  timeMs: number;
}

/**
 * Microphone (or a test oscillator) → YIN, polled from rAF / a timer.
 * The raw audio never leaves the device.
 */
export class PitchTracker {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private testOsc: OscillatorNode | null = null;
  private testGain: GainNode | null = null;
  private injectedHz: number | null = null;
  private readonly opts: Required<TrackerOptions>;

  constructor(options: TrackerOptions = {}) {
    this.opts = {
      fftSize: options.fftSize ?? 4096,
      threshold: options.threshold ?? 0.15,
      minHz: options.minHz ?? 70,
      maxHz: options.maxHz ?? 1200,
      minProbability: options.minProbability ?? 0.7,
    };
  }

  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.opts.fftSize;
      this.analyser.smoothingTimeConstant = 0;
      this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  async startMic(): Promise<void> {
    const ctx = await this.ensureContext();
    this.stopMic();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.analyser!);
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
   * (silent — gain is ~0 to the destination, but full into the analyser).
   */
  async startTestTone(hz: number): Promise<void> {
    const ctx = await this.ensureContext();
    this.stopTestTone();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    // Analyser sees the tone; speakers stay quiet.
    gain.gain.value = 0.8;
    osc.connect(gain);
    gain.connect(this.analyser!);
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
  injectHz(hz: number | null): void {
    this.injectedHz = hz;
  }

  read(nowMs: number = performance.now()): TrackerReading {
    if (this.injectedHz !== null) {
      return { frequency: this.injectedHz, probability: 1, timeMs: nowMs };
    }
    if (!this.analyser || !this.buffer || !this.ctx) {
      return { frequency: null, probability: 0, timeMs: nowMs };
    }
    const buf = this.buffer;
    this.analyser.getFloatTimeDomainData(buf);
    const result = yinDetect(buf, this.ctx.sampleRate, {
      threshold: this.opts.threshold,
      minHz: this.opts.minHz,
      maxHz: this.opts.maxHz,
    });
    const voiced = result.frequency !== null && result.probability >= this.opts.minProbability;
    return {
      frequency: voiced ? result.frequency : null,
      probability: result.probability,
      timeMs: nowMs,
    };
  }

  async close(): Promise<void> {
    this.stopMic();
    this.stopTestTone();
    this.injectedHz = null;
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
    this.analyser = null;
    this.buffer = null;
  }
}

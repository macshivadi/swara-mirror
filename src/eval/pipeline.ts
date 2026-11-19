/**
 * The same pitch → swara → notation path the live app uses, for offline
 * evaluation. Hop is rAF-like (1/60 s) by default; the YIN window,
 * thresholds, octave folding, hysteresis and collector settings match
 * `AUDIO_SETTINGS`.
 */
import { applyMakeupGain, rms } from '../audio/level';
import { OctaveStabilizer } from '../audio/octave';
import { KeyboardRegister, MedianFrequencySmoother } from '../audio/register';
import { AUDIO_SETTINGS as S } from '../audio/settings';
import { yinDetect } from '../audio/yin';
import { defaultForgiving, settingsFor, type SkillLevel } from '../music/levels';
import {
  compactSwaraSequence,
  DisplaySmoother,
  NotationCollector,
  withHysteresis,
  type NotationEvent,
} from '../music/notation';
import { hzToSwara, type PitchClass } from '../music/swara';
import { estimateTonicHz, type TonicEstimate } from '../music/tonic';

export interface PipelineFrame {
  timeMs: number;
  frequency: number | null;
  rawFrequency: number | null;
  probability: number;
  rms: number;
  pitch: PitchClass | null;
}

export interface PipelineResult {
  frames: PipelineFrame[];
  events: NotationEvent[];
  sequence: string[];
  voicedFrameCount: number;
  saHz: number;
  tonic: TonicEstimate | null;
}

export interface NotationSettings {
  notationHoldMs?: number;
  notationRestMs?: number;
  hysteresisCents?: number;
  escapeCents?: number;
  displayHoldMs?: number;
  medianFrames?: number;
  level?: SkillLevel;
  forgiving?: boolean;
}

export interface RunPipelineOptions extends NotationSettings {
  /** Pass `'auto'` to estimate Sa from the take, then label swaras in that key. */
  saHz: number | 'auto';
  hopSize?: number;
  fftSize?: number;
  mode?: 'listen' | 'calibrate';
}

export function hopSizeFor(sampleRate: number): number {
  return Math.max(128, Math.round(sampleRate / 60));
}

export function runPipeline(
  samples: Float32Array,
  sampleRate: number,
  options: RunPipelineOptions,
): PipelineResult {
  const fftSize = options.fftSize ?? S.fftSize;
  const hop = options.hopSize ?? hopSizeFor(sampleRate);
  const mode = options.mode ?? 'listen';
  const threshold = mode === 'calibrate' ? S.calibrateThreshold : S.listenThreshold;
  const minProbability = mode === 'calibrate' ? S.calibrateMinProbability : S.listenMinProbability;
  const minRms = mode === 'calibrate' ? S.calibrateMinRms : S.listenMinRms;

  const detected: DetectedFrame[] = [];
  const octave = new OctaveStabilizer(S.octaveConfirmMs);
  const work = new Float32Array(fftSize);
  const window = new Float32Array(fftSize);

  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    window.set(samples.subarray(start, start + fftSize));
    const timeMs = (start / sampleRate) * 1000;
    const levelRms = rms(window);
    let rawFrequency: number | null = null;
    let probability = 0;
    let frequency: number | null = null;

    if (levelRms >= minRms) {
      applyMakeupGain(window, work, {
        floorRms: minRms * 0.5,
        targetRms: S.makeupTargetRms,
        maxGain: S.makeupMaxGain,
      });
      const yin = yinDetect(work, sampleRate, {
        threshold,
        minHz: S.minHz,
        maxHz: S.maxHz,
      });
      probability = yin.probability;
      rawFrequency = yin.frequency;
      const gated = yin.frequency !== null && yin.probability >= minProbability ? yin.frequency : null;
      frequency = octave.update(timeMs, gated);
    } else {
      octave.update(timeMs, null);
    }

    detected.push({ timeMs, frequency, rawFrequency, probability, rms: levelRms });
  }

  const hopMs = (hop / sampleRate) * 1000;
  const tonic = estimateTonicHz(
    detected.map((d) => d.frequency),
    { hopMs },
  );
  const saHz = options.saHz === 'auto' ? (tonic?.hz ?? 220) : options.saHz;
  const noted = notateFrames(
    detected.map((d) => ({ timeMs: d.timeMs, frequency: d.frequency })),
    saHz,
    options,
  );
  const frames = noted.frames.map((fr, i) => ({
    ...fr,
    rawFrequency: detected[i]?.rawFrequency ?? fr.rawFrequency,
    probability: detected[i]?.probability ?? fr.probability,
    rms: detected[i]?.rms ?? fr.rms,
  }));
  return {
    ...noted,
    frames,
    saHz,
    tonic,
    voicedFrameCount: frames.filter((f) => f.frequency !== null).length,
  };
}

interface DetectedFrame {
  timeMs: number;
  frequency: number | null;
  rawFrequency: number | null;
  probability: number;
  rms: number;
}

export function resolveNotationSettings(options: NotationSettings = {}): Required<
  Pick<
    NotationSettings,
    'notationHoldMs' | 'notationRestMs' | 'hysteresisCents' | 'escapeCents' | 'displayHoldMs' | 'medianFrames'
  >
> {
  const forgiving = options.forgiving ?? (options.level ? defaultForgiving(options.level) : false);
  const preset = options.level ? settingsFor(options.level, forgiving) : null;
  return {
    notationHoldMs: options.notationHoldMs ?? preset?.notationHoldMs ?? S.notationHoldMs,
    notationRestMs: options.notationRestMs ?? preset?.notationRestMs ?? S.notationRestMs,
    hysteresisCents: options.hysteresisCents ?? preset?.hysteresisCents ?? S.hysteresisCents,
    escapeCents: options.escapeCents ?? preset?.escapeCents ?? 90,
    displayHoldMs: options.displayHoldMs ?? preset?.displayHoldMs ?? S.displayHoldMs,
    medianFrames: options.medianFrames ?? preset?.medianFrames ?? 0,
  };
}

/** Re-run only the notation stage on an already-detected frequency stream. */
export function notateFrames(
  frames: readonly Pick<PipelineFrame, 'timeMs' | 'frequency'>[],
  saHz: number,
  options: NotationSettings = {},
): PipelineResult {
  const notation = resolveNotationSettings(options);
  const register = new KeyboardRegister();
  const median = new MedianFrequencySmoother(notation.medianFrames || 1);
  const useMedian = notation.medianFrames > 0;
  const smoother = new DisplaySmoother(notation.displayHoldMs);
  const collector = new NotationCollector({ holdMs: notation.notationHoldMs, restMs: notation.notationRestMs });
  let sticky: PitchClass | null = null;
  const out: PipelineFrame[] = [];
  for (const fr of frames) {
    let frequency = register.update(fr.timeMs, fr.frequency, saHz);
    if (useMedian) frequency = median.update(frequency);
    const classified = frequency ? hzToSwara(frequency, saHz) : null;
    const held: PitchClass | null = classified
      ? withHysteresis(sticky, classified, notation.hysteresisCents, notation.escapeCents)
      : null;
    sticky = held;
    const display = smoother.update(fr.timeMs, held);
    collector.update(fr.timeMs, held);
    out.push({
      timeMs: fr.timeMs,
      frequency,
      rawFrequency: fr.frequency,
      probability: fr.frequency ? 1 : 0,
      rms: 0,
      pitch: display,
    });
  }
  return {
    frames: out,
    events: [...collector.getEvents()],
    sequence: compactSwaraSequence(collector.getEvents()),
    voicedFrameCount: out.filter((f) => f.frequency !== null).length,
    saHz,
    tonic: null,
  };
}

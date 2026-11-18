/**
 * The same pitch → swara → notation path the live app uses, for offline
 * evaluation. Hop is rAF-like (1/60 s) by default; the YIN window,
 * thresholds, octave folding, hysteresis and collector settings match
 * `AUDIO_SETTINGS`.
 */
import { applyMakeupGain, rms } from '../audio/level';
import { OctaveStabilizer } from '../audio/octave';
import { AUDIO_SETTINGS as S } from '../audio/settings';
import { yinDetect } from '../audio/yin';
import {
  compactSwaraSequence,
  DisplaySmoother,
  NotationCollector,
  withHysteresis,
  type NotationEvent,
} from '../music/notation';
import { hzToSwara, type PitchClass } from '../music/swara';

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
}

export interface RunPipelineOptions {
  saHz: number;
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

  const octave = new OctaveStabilizer(S.octaveConfirmMs);
  const smoother = new DisplaySmoother(S.displayHoldMs);
  const collector = new NotationCollector({ holdMs: S.notationHoldMs, restMs: S.notationRestMs });
  let sticky: PitchClass | null = null;

  const frames: PipelineFrame[] = [];
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
      const detected = yinDetect(work, sampleRate, {
        threshold,
        minHz: S.minHz,
        maxHz: S.maxHz,
      });
      probability = detected.probability;
      rawFrequency = detected.frequency;
      const gated = detected.frequency !== null && detected.probability >= minProbability ? detected.frequency : null;
      frequency = octave.update(timeMs, gated);
    } else {
      octave.update(timeMs, null);
    }

    const classified = frequency ? hzToSwara(frequency, options.saHz) : null;
    const held: PitchClass | null = classified ? withHysteresis(sticky, classified, S.hysteresisCents) : null;
    sticky = held;
    const display = smoother.update(timeMs, held);
    collector.update(timeMs, held);

    frames.push({
      timeMs,
      frequency,
      rawFrequency,
      probability,
      rms: levelRms,
      pitch: display,
    });
  }

  return {
    frames,
    events: [...collector.getEvents()],
    sequence: compactSwaraSequence(collector.getEvents()),
    voicedFrameCount: frames.filter((f) => f.frequency !== null).length,
  };
}

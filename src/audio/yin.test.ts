import { describe, expect, it } from 'vitest';
import { synthesizeSine, yinDetect } from './yin';

function detect(freq: number, sampleRate = 44100, length = 4096) {
  const buf = synthesizeSine(freq, sampleRate, length);
  return yinDetect(buf, sampleRate);
}

function nearly(actual: number | null, expected: number, centsTol = 8): void {
  expect(actual).not.toBeNull();
  const cents = 1200 * Math.log2(actual! / expected);
  expect(Math.abs(cents)).toBeLessThan(centsTol);
}

describe('yinDetect on synthetic sines', () => {
  it('detects A4 = 440 Hz at 44.1 kHz', () => {
    const result = detect(440, 44100);
    nearly(result.frequency, 440, 5);
    expect(result.probability).toBeGreaterThan(0.8);
  });

  it('detects A4 = 440 Hz at 48 kHz', () => {
    const result = detect(440, 48000);
    nearly(result.frequency, 440, 5);
    expect(result.probability).toBeGreaterThan(0.8);
  });

  it('detects C4 ≈ 261.63 Hz', () => {
    nearly(detect(261.626).frequency, 261.626, 8);
  });

  it('detects a low C3 ≈ 130.81 Hz', () => {
    nearly(detect(130.813, 44100, 8192).frequency, 130.813, 10);
  });

  it('detects A5 = 880 Hz', () => {
    nearly(detect(880).frequency, 880, 8);
  });

  it('detects 233 Hz (near A#3, a common Sa)', () => {
    nearly(detect(233).frequency, 233, 8);
  });

  it('returns null for silence', () => {
    const buf = new Float32Array(4096);
    const result = yinDetect(buf, 44100);
    expect(result.frequency).toBeNull();
  });

  it('returns null or very low probability for white noise', () => {
    const buf = new Float32Array(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.random() * 2 - 1;
    const result = yinDetect(buf, 44100, { threshold: 0.1 });
    // Noise may occasionally look pitched; require that if a freq is returned,
    // confidence is not extremely high AND we mostly expect null.
    if (result.frequency !== null) {
      expect(result.probability).toBeLessThan(0.9);
    }
  });

  it('is robust to phase and moderate amplitude', () => {
    const buf = synthesizeSine(392, 48000, 4096, { amplitude: 0.2, phase: 1.3 });
    nearly(yinDetect(buf, 48000).frequency, 392, 8);
  });
});

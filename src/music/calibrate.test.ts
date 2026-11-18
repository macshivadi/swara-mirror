import { describe, expect, it } from 'vitest';
import { calibrationErrorMessage, evaluateCalibration, type CalibrateSample } from './calibrate';
import { westernNoteToHz } from './swara';

function samplesAround(hz: number, startMs: number, durationMs: number, step = 16, vibratoCents = 0, vibratoHz = 5.5): CalibrateSample[] {
  const out: CalibrateSample[] = [];
  for (let t = 0; t <= durationMs; t += step) {
    const cents = vibratoCents * Math.sin((2 * Math.PI * vibratoHz * t) / 1000);
    out.push({ timeMs: startMs + t, frequency: hz * 2 ** (cents / 1200) });
  }
  return out;
}

describe('evaluateCalibration', () => {
  it('waits until there is enough inlier voicing', () => {
    const s = samplesAround(220, 0, 400);
    const r = evaluateCalibration(s, 400);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('waiting');
  });

  it('accepts a slightly wavering note and snaps to the nearest semitone', () => {
    const s = samplesAround(223, 0, 900, 16, 30);
    const r = evaluateCalibration(s, 1200);
    expect(r.ok).toBe(true);
    expect(r.snappedNote).toBe('A3');
    expect(r.snappedHz).toBeCloseTo(westernNoteToHz('A3'), 5);
    expect(r.inlierMs).toBeGreaterThanOrEqual(600);
  });

  it('accepts a noisy cluster of octave jumps once folded', () => {
    const base = samplesAround(261.63, 0, 1000, 16, 20);
    const mixed: CalibrateSample[] = base.map((s, i) =>
      i % 7 === 0 ? { ...s, frequency: s.frequency * 2 } : s,
    );
    const r = evaluateCalibration(mixed, 1500);
    expect(r.ok).toBe(true);
    expect(r.snappedNote).toBe('C4');
  });

  it('accepts at max wait with a slightly short inlier run', () => {
    const s = samplesAround(196, 3200, 650, 16, 25);
    const r = evaluateCalibration(s, 4000);
    expect(r.ok).toBe(true);
    expect(r.snappedNote).toBe('G3');
  });

  it('rejects silence after the full window', () => {
    const r = evaluateCalibration([], 4000);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-voicing');
    expect(calibrationErrorMessage(r.reason)).toMatch(/list/);
    expect(calibrationErrorMessage(r.reason).length).toBeGreaterThan(40);
  });

  it('rejects a wandering pitch that never settles', () => {
    const s: CalibrateSample[] = [];
    for (let i = 0; i < 200; i++) {
      const hz = 200 * 2 ** (i / 40); // a continuous glide
      s.push({ timeMs: i * 16, frequency: hz });
    }
    const r = evaluateCalibration(s, 4000);
    expect(r.ok).toBe(false);
    expect(['too-unsteady', 'too-short']).toContain(r.reason);
  });
});

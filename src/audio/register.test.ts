import { describe, expect, it } from 'vitest';
import { westernNoteToHz } from '../music/swara';
import {
  applyOctaveShift,
  keyboardRangeHz,
  KeyboardRegister,
  MedianFrequencySmoother,
  octaveShiftToKeyboard,
} from './register';

describe('octave shift to the keyboard', () => {
  const sa = westernNoteToHz('C4');

  it('keeps voice-range notes unchanged', () => {
    expect(octaveShiftToKeyboard(sa, sa)).toBe(0);
    expect(octaveShiftToKeyboard(westernNoteToHz('G4'), sa)).toBe(0);
  });

  it('folds a whistle two octaves down into the Sa keyboard', () => {
    const c6 = westernNoteToHz('C6');
    const shift = octaveShiftToKeyboard(c6, sa);
    expect(shift).toBe(2);
    const folded = applyOctaveShift(c6, shift);
    const { minHz, maxHz } = keyboardRangeHz(sa);
    expect(folded).toBeGreaterThanOrEqual(minHz);
    expect(folded).toBeLessThanOrEqual(maxHz);
    expect(folded).toBeCloseTo(sa, 4);
  });
});

describe('KeyboardRegister', () => {
  const sa = westernNoteToHz('C4');

  it('stays in voice mode for ordinary singing', () => {
    const reg = new KeyboardRegister();
    for (let t = 0; t < 500; t += 16) reg.update(t, westernNoteToHz('E4'), sa);
    expect(reg.isWhistle()).toBe(false);
    expect(reg.update(520, westernNoteToHz('E4'), sa)).toBeCloseTo(westernNoteToHz('E4'), 4);
  });

  it('enters whistle mode after a short confirm and keeps one octave shift for the phrase', () => {
    const reg = new KeyboardRegister();
    const c6 = westernNoteToHz('C6');
    const g6 = westernNoteToHz('G6');
    let out: number | null = null;
    for (let t = 0; t <= 140; t += 16) out = reg.update(t, c6, sa);
    expect(reg.isWhistle()).toBe(true);
    expect(reg.octaveShift()).toBe(2);
    expect(out!).toBeCloseTo(sa, 3);
    out = reg.update(200, g6, sa);
    expect(out!).toBeCloseTo(westernNoteToHz('G4'), 3);
  });

  it('returns to voice mode after a held low note', () => {
    const reg = new KeyboardRegister();
    for (let t = 0; t <= 140; t += 16) reg.update(t, westernNoteToHz('C6'), sa);
    expect(reg.isWhistle()).toBe(true);
    for (let t = 160; t <= 320; t += 16) reg.update(t, westernNoteToHz('C4'), sa);
    expect(reg.isWhistle()).toBe(false);
  });
});

describe('MedianFrequencySmoother', () => {
  it('rejects single-frame spikes', () => {
    const m = new MedianFrequencySmoother(5);
    const seq = [440, 441, 880, 439, 440];
    let out = 0;
    for (const hz of seq) out = m.update(hz)!;
    expect(out).toBeCloseTo(440, 0);
  });

  it('clears on silence', () => {
    const m = new MedianFrequencySmoother(5);
    m.update(440);
    expect(m.update(null)).toBeNull();
    expect(m.update(220)).toBe(220);
  });
});

  it('follows a confirmed leap without staying on the old median', () => {
    const m = new MedianFrequencySmoother(5);
    for (const hz of [165, 166, 164, 165, 165]) m.update(hz);
    // one-frame dip is ignored
    expect(m.update(114)!).toBeCloseTo(165, 0);
    // second frame in the new region resets
    expect(m.update(115)!).toBeLessThan(130);
    expect(m.update(114)!).toBeCloseTo(114, 0);
  });

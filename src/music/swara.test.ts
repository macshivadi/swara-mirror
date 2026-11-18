import { describe, expect, it } from 'vitest';
import {
  formatSwaraAscii,
  hzToSwara,
  hzToWesternNote,
  midiToHz,
  SA_DROPDOWN_NOTES,
  swaraToHz,
  SWARA_NAMES,
  westernNoteToHz,
  westernNoteToMidi,
} from './swara';
import { DisplaySmoother, NotationCollector } from './notation';

const SA = 261.625565; // C4

function centsOff(actualHz: number, expectedHz: number): number {
  return 1200 * Math.log2(actualHz / expectedHz);
}

describe('western note conversion', () => {
  it('maps A4 to MIDI 69 and 440 Hz', () => {
    expect(westernNoteToMidi('A4')).toBe(69);
    expect(westernNoteToHz('A4')).toBeCloseTo(440, 6);
  });

  it('maps C4 to MIDI 60', () => {
    expect(westernNoteToMidi('C4')).toBe(60);
    expect(westernNoteToHz('C4')).toBeCloseTo(midiToHz(60), 10);
  });

  it('round-trips a list of dropdown notes', () => {
    for (const note of ['C2', 'C#3', 'D4', 'F#4', 'A4', 'C5', 'C6']) {
      const hz = westernNoteToHz(note);
      expect(hzToWesternNote(hz).note).toBe(note);
    }
  });

  it('includes a useful Sa dropdown range', () => {
    expect(SA_DROPDOWN_NOTES[0]).toBe('C2');
    expect(SA_DROPDOWN_NOTES.at(-1)).toBe('C6');
    expect(SA_DROPDOWN_NOTES).toContain('C#4');
  });
});

describe('frequency → swara mapping', () => {
  it('maps Sa itself to S, madhya, 0 cents', () => {
    const p = hzToSwara(SA, SA);
    expect(p.swara).toBe('S');
    expect(p.octave).toBe(0);
    expect(p.semitone).toBe(0);
    expect(Math.abs(p.cents)).toBeLessThan(0.001);
  });

  it('maps the upper octave Sa to S tara', () => {
    const p = hzToSwara(SA * 2, SA);
    expect(p.swara).toBe('S');
    expect(p.octave).toBe(1);
    expect(Math.abs(p.cents)).toBeLessThan(0.001);
  });

  it('maps the lower octave Sa to S mandra', () => {
    const p = hzToSwara(SA / 2, SA);
    expect(p.swara).toBe('S');
    expect(p.octave).toBe(-1);
  });

  it('maps a just-below Sa as mandra N3', () => {
    const hz = swaraToHz('N3', -1, SA);
    const p = hzToSwara(hz, SA);
    expect(p.swara).toBe('N3');
    expect(p.octave).toBe(-1);
    expect(Math.abs(p.cents)).toBeLessThan(0.01);
  });

  it('maps Panchama (7 semitones) to P', () => {
    const hz = SA * 2 ** (7 / 12);
    const p = hzToSwara(hz, SA);
    expect(p.swara).toBe('P');
    expect(p.octave).toBe(0);
    expect(Math.abs(p.cents)).toBeLessThan(0.01);
  });

  it('uses the common labels for the 12 shrutis', () => {
    const expected = [...SWARA_NAMES];
    expected.forEach((name, i) => {
      const hz = SA * 2 ** (i / 12);
      expect(hzToSwara(hz, SA).swara).toBe(name);
    });
  });

  it('reports cents sharp and flat of a swara', () => {
    const r2 = swaraToHz('R2', 0, SA);
    const sharp = r2 * 2 ** (15 / 1200);
    const flat = r2 * 2 ** (-20 / 1200);
    expect(hzToSwara(sharp, SA).swara).toBe('R2');
    expect(hzToSwara(sharp, SA).cents).toBeCloseTo(15, 6);
    expect(hzToSwara(flat, SA).swara).toBe('R2');
    expect(hzToSwara(flat, SA).cents).toBeCloseTo(-20, 6);
  });

  it('switches to the next swara past 50 cents (tie toward +∞)', () => {
    const justOver = SA * 2 ** (50.1 / 1200);
    expect(hzToSwara(justOver, SA).swara).toBe('R1');
  });

  it('round-trips every swara in mandra, madhya and tara', () => {
    for (const octave of [-1, 0, 1]) {
      for (const swara of SWARA_NAMES) {
        const hz = swaraToHz(swara, octave, SA);
        const p = hzToSwara(hz, SA);
        expect(p.swara).toBe(swara);
        expect(p.octave).toBe(octave);
        expect(Math.abs(centsOff(p.frequency, hz))).toBeLessThan(0.001);
      }
    }
  });

  it('formats mandra and tara in ASCII', () => {
    expect(formatSwaraAscii('S', 0)).toBe('S');
    expect(formatSwaraAscii('G3', -1)).toBe('.G3');
    expect(formatSwaraAscii('P', 1)).toBe("P'");
    expect(formatSwaraAscii('S', 2)).toBe("S''");
  });
});

describe('NotationCollector', () => {
  it('writes a swara only after it is held long enough', () => {
    const c = new NotationCollector({ holdMs: 160, restMs: 280 });
    c.update(0, { swara: 'S', octave: 0 });
    c.update(100, { swara: 'S', octave: 0 });
    expect(c.toAsciiText()).toBe('');
    c.update(160, { swara: 'S', octave: 0 });
    expect(c.toAsciiText()).toBe('S');
  });

  it('does not repeat a continuing swara, and records a new one after a change', () => {
    const c = new NotationCollector({ holdMs: 100, restMs: 200 });
    c.update(0, { swara: 'S', octave: 0 });
    c.update(100, { swara: 'S', octave: 0 });
    c.update(200, { swara: 'R2', octave: 0 });
    c.update(300, { swara: 'R2', octave: 0 });
    c.update(450, { swara: 'G3', octave: 0 });
    c.update(550, { swara: 'G3', octave: 0 });
    expect(c.toAsciiText()).toBe('S R2 G3');
  });

  it('inserts a rest after a long enough silence', () => {
    const c = new NotationCollector({ holdMs: 80, restMs: 200 });
    c.update(0, { swara: 'S', octave: 0 });
    c.update(80, { swara: 'S', octave: 0 });
    c.update(100, null);
    c.update(250, null);
    expect(c.toAsciiText()).toBe('S');
    c.update(300, null);
    expect(c.toAsciiText()).toBe('S -');
    c.update(400, { swara: 'P', octave: 0 });
    c.update(500, { swara: 'P', octave: 0 });
    expect(c.toAsciiText()).toBe('S - P');
  });

  it('treats a tara Sa as distinct from madhya Sa', () => {
    const c = new NotationCollector({ holdMs: 80, restMs: 200 });
    c.update(0, { swara: 'S', octave: 0 });
    c.update(80, { swara: 'S', octave: 0 });
    c.update(200, { swara: 'S', octave: 1 });
    c.update(280, { swara: 'S', octave: 1 });
    expect(c.toAsciiText()).toBe("S S'");
  });

  it('clears the strip', () => {
    const c = new NotationCollector({ holdMs: 50 });
    c.update(0, { swara: 'P', octave: 0 });
    c.update(50, { swara: 'P', octave: 0 });
    c.clear();
    expect(c.toAsciiText()).toBe('');
  });
});

describe('DisplaySmoother', () => {
  it('holds the previous swara until a new one is consistent', () => {
    const s = new DisplaySmoother(80);
    const sa = hzToSwara(SA, SA);
    const r1 = hzToSwara(swaraToHz('R1', 0, SA), SA);
    expect(s.update(0, sa)?.swara).toBe('S');
    expect(s.update(20, r1)?.swara).toBe('S');
    expect(s.update(60, r1)?.swara).toBe('S');
    expect(s.update(100, r1)?.swara).toBe('R1');
  });

  it('resets on silence', () => {
    const s = new DisplaySmoother(80);
    s.update(0, hzToSwara(SA, SA));
    expect(s.update(10, null)).toBeNull();
  });
});

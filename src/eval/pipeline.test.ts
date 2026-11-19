import { describe, expect, it } from 'vitest';
import { synthesizeSine, synthesizeVoice } from '../audio/yin';
import { withHysteresis } from '../music/notation';
import { hzToSwara, swaraToHz, swaraToWesternNote, westernNoteToHz } from '../music/swara';
import { runPipeline } from './pipeline';

const SA = westernNoteToHz('C4');

function concat(parts: Float32Array[]): Float32Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('withHysteresis', () => {
  it('holds the previous swara when the new one is only just across the boundary', () => {
    const sa = hzToSwara(SA, SA);
    const justR1 = hzToSwara(SA * 2 ** (55 / 1200), SA);
    expect(justR1.swara).toBe('R1');
    expect(withHysteresis(sa, justR1, 18).swara).toBe('S');
    const deepR1 = hzToSwara(SA * 2 ** (100 / 1200), SA);
    expect(withHysteresis(sa, deepR1, 18).swara).toBe('R1');
  });

  it('leaves a held swara immediately when pitch jumps past escapeCents', () => {
    const sa = hzToSwara(SA, SA);
    const far = hzToSwara(SA * 2 ** (300 / 1200), SA);
    expect(far.swara).not.toBe('S');
    // Wide stay-window (50+32) would still be closer than 82 only for small moves;
    // a 300-cent dip must not stay on Sa.
    expect(withHysteresis(sa, far, 32, 70).swara).toBe(far.swara);
  });
});

describe('runPipeline on synthetic sung scales', () => {
  it('recovers a clean S R2 G3 P S\' scale', () => {
    const sr = 44100;
    const beat = Math.round(sr * 0.35);
    const notes = [
      swaraToHz('S', 0, SA),
      swaraToHz('R2', 0, SA),
      swaraToHz('G3', 0, SA),
      swaraToHz('P', 0, SA),
      swaraToHz('S', 1, SA),
    ];
    const audio = concat(notes.map((hz) => synthesizeSine(hz, sr, beat, { amplitude: 0.4 })));
    const result = runPipeline(audio, sr, { saHz: SA });
    expect(result.sequence).toEqual(['S', 'R2', 'G3', 'P', "S'"]);
  });

  it('recovers the same scale under vibrato and light noise, without a flood of short notes', () => {
    const sr = 44100;
    const beat = Math.round(sr * 0.4);
    const notes = [
      swaraToHz('S', 0, SA),
      swaraToHz('R2', 0, SA),
      swaraToHz('G3', 0, SA),
      swaraToHz('P', 0, SA),
    ];
    const audio = concat(
      notes.map((hz, i) =>
        synthesizeVoice(hz, sr, beat, {
          amplitude: 0.3,
          vibratoHz: 5.5,
          vibratoCents: 25,
          noise: 0.03,
          seed: 20 + i,
        }),
      ),
    );
    const result = runPipeline(audio, sr, { saHz: SA });
    expect(result.sequence).toEqual(['S', 'R2', 'G3', 'P']);
    expect(result.events.filter((e) => e.type === 'note').length).toBe(4);
  });

  it('does not emit a spurious neighbour from a 40 ms consonant-like blip', () => {
    const sr = 44100;
    const sa = synthesizeSine(SA, sr, Math.round(sr * 0.4), { amplitude: 0.4 });
    const blip = synthesizeSine(swaraToHz('R1', 0, SA), sr, Math.round(sr * 0.04), { amplitude: 0.4 });
    const sa2 = synthesizeSine(SA, sr, Math.round(sr * 0.4), { amplitude: 0.4 });
    const result = runPipeline(concat([sa, blip, sa2]), sr, { saHz: SA });
    expect(result.sequence).toEqual(['S']);
  });
});

describe('melody capture', () => {
  it('captures a dip of a third after a long note in forgiving mode', () => {
    const sr = 44100;
    const parts = [
      ['E3', 0.5],
      ['G3', 0.4],
      ['F#3', 0.35],
      ['D3', 0.4],
      ['E3', 1.2],
      ['C#3', 0.35],
      ['A#2', 0.5],
      ['D3', 0.4],
      ['F#3', 0.4],
    ] as const;
    const audio = concat(
      parts.map(([n, sec]) => synthesizeSine(westernNoteToHz(n), sr, Math.round(sr * sec), { amplitude: 0.4 })),
    );
    const result = runPipeline(audio, sr, { saHz: westernNoteToHz('E3'), level: 'beginner', forgiving: true });
    // Compact Western sequence should include the A#2 dip, not swallow it into C#3.
    const west = result.events
      .filter((e) => e.type === 'note')
      .map((e) => swaraToWesternNote(e.swara, e.octave, result.saHz));
    const compact: string[] = [];
    for (const w of west) {
      if (compact[compact.length - 1] !== w) compact.push(w);
    }
    expect(compact).toContain('A#2');
    expect(compact).toEqual(expect.arrayContaining(['E3', 'G3', 'F#3', 'D3', 'C#3', 'A#2']));
  });

  it('estimates Sa as E3 when saHz is auto on an E-centered phrase', () => {
    const sr = 44100;
    const parts = [
      ['E3', 0.5],
      ['G3', 0.35],
      ['B3', 0.3],
      ['E3', 1.0],
      ['D3', 0.4],
    ] as const;
    const audio = concat(
      parts.map(([n, sec]) => synthesizeSine(westernNoteToHz(n), sr, Math.round(sr * sec), { amplitude: 0.4 })),
    );
    const result = runPipeline(audio, sr, { saHz: 'auto', level: 'beginner', forgiving: true });
    expect(result.saHz).toBeCloseTo(westernNoteToHz('E3'), 1);
    expect(result.tonic?.note).toBe('E3');
    expect(result.sequence[0]).toBe('S');
  });
});

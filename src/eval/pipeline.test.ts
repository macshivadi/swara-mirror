import { describe, expect, it } from 'vitest';
import { synthesizeSine, synthesizeVoice } from '../audio/yin';
import { withHysteresis } from '../music/notation';
import { hzToSwara, swaraToHz, westernNoteToHz } from '../music/swara';
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

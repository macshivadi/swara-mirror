import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from '../audio/wav';
import {
  synthesizeGlide,
  synthesizeHarmonicVoice,
  synthesizeSine,
  synthesizeWhistle,
} from '../audio/yin';
import { swaraToWesternNote, westernNoteToHz } from '../music/swara';
import { runPipeline } from './pipeline';

const SA = westernNoteToHz('C4');
const SR = 44100;

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

const ABC = ['C', 'C', 'G', 'G', 'A', 'A', 'G', 'F', 'F', 'E', 'E', 'D', 'D', 'C'] as const;
const ABC_COMPACT = ['C', 'G', 'A', 'G', 'F', 'E', 'D', 'C'] as const;

function westernPhrase(events: readonly { type: string; swara?: string; octave?: number }[]): string[] {
  return events
    .filter((e) => e.type === 'note')
    .map((e) => swaraToWesternNote(e.swara as 'S', e.octave as number, SA).replace(/\d+$/, ''));
}

function compactWestern(pcs: string[]): string[] {
  const out: string[] = [];
  for (const p of pcs) {
    if (out[out.length - 1] !== p) out.push(p);
  }
  return out;
}

function octavesOf(events: readonly { type: string; swara?: string; octave?: number }[]): number[] {
  return [
    ...new Set(
      events
        .filter((e) => e.type === 'note')
        .map((e) => Number(swaraToWesternNote(e.swara as 'S', e.octave as number, SA).replace(/^[A-G]#?/, ''))),
    ),
  ];
}

describe('whistle and forgiving pipeline', () => {
  it('transcribes a whistled ABC melody at C6 down onto the C4 keyboard', () => {
    const beat = Math.round(SR * 0.4);
    const audio = concat(
      ABC.map((pc, i) => synthesizeWhistle(westernNoteToHz(`${pc}6`), SR, beat, { seed: 20 + i })),
    );
    const dir = join(tmpdir(), 'swara-mirror-whistle');
    mkdirSync(dir, { recursive: true });
    const wavPath = join(dir, 'abc-c6.wav');
    writeFileSync(wavPath, encodeWav(audio, SR));
    const decoded = decodeWav(new Uint8Array(readFileSync(wavPath)));
    expect(decoded.sampleRate).toBe(SR);
    expect(decoded.samples.length).toBe(audio.length);

    const result = runPipeline(decoded.samples, decoded.sampleRate, { saHz: SA, level: 'beginner', forgiving: true });
    expect(compactWestern(westernPhrase(result.events))).toEqual([...ABC_COMPACT]);
    const octs = octavesOf(result.events);
    expect(octs.length).toBe(1);
    expect(octs[0]).toBe(4);
  });

  it('transcribes the same ABC phrase whistled at C7', () => {
    const beat = Math.round(SR * 0.4);
    const audio = concat(
      ABC.map((pc, i) => synthesizeWhistle(westernNoteToHz(`${pc}7`), SR, beat, { seed: 40 + i })),
    );
    const result = runPipeline(audio, SR, { saHz: SA, level: 'beginner', forgiving: true });
    expect(compactWestern(westernPhrase(result.events))).toEqual([...ABC_COMPACT]);
    const octs = octavesOf(result.events);
    expect(octs.length).toBe(1);
    expect(octs[0]).toBeGreaterThanOrEqual(3);
    expect(octs[0]).toBeLessThanOrEqual(5);
  });

  it('keeps a sung harmonic scale in the original octave', () => {
    const beat = Math.round(SR * 0.4);
    const notes = ['C4', 'D4', 'E4', 'G4', 'C5'];
    const audio = concat(
      notes.map((n, i) =>
        synthesizeHarmonicVoice(westernNoteToHz(n), SR, beat, {
          vibratoHz: 5.5,
          vibratoCents: 22,
          noise: 0.02,
          seed: 8 + i,
        }),
      ),
    );
    const result = runPipeline(audio, SR, { saHz: SA });
    expect(result.sequence).toEqual(['S', 'R2', 'G3', 'P', "S'"]);
  });

  it('drops a short slide between two held notes in forgiving mode', () => {
    const hold = Math.round(SR * 0.45);
    const slide = Math.round(SR * 0.08);
    const audio = concat([
      synthesizeSine(westernNoteToHz('C4'), SR, hold, { amplitude: 0.4 }),
      synthesizeGlide(westernNoteToHz('C4'), westernNoteToHz('D4'), SR, slide),
      synthesizeSine(westernNoteToHz('D4'), SR, hold, { amplitude: 0.4 }),
    ]);
    const result = runPipeline(audio, SR, { saHz: SA, level: 'beginner', forgiving: true });
    const pcs = compactWestern(westernPhrase(result.events));
    expect(pcs).toEqual(['C', 'D']);
    expect(pcs).not.toContain('C#');
  });
});

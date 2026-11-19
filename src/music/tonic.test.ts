import { describe, expect, it } from 'vitest';
import { westernNoteToHz } from './swara';
import { estimateTonicHz } from './tonic';

function phrase(notes: Array<[string, number]>, hopMs = 16): (number | null)[] {
  const out: (number | null)[] = [];
  for (const [name, ms] of notes) {
    const hz = westernNoteToHz(name);
    const n = Math.round(ms / hopMs);
    for (let i = 0; i < n; i++) out.push(hz);
    out.push(null);
  }
  return out;
}

describe('estimateTonicHz', () => {
  it('places Sa on E3 for a melody that lingers on E and visits its fifth', () => {
    const freqs = phrase([
      ['E3', 500],
      ['G3', 300],
      ['F#3', 250],
      ['D3', 300],
      ['E3', 1800],
      ['C#3', 300],
      ['A#2', 500],
      ['F#3', 400],
      ['D3', 800],
      ['B3', 200],
    ]);
    const est = estimateTonicHz(freqs);
    expect(est).not.toBeNull();
    expect(est!.note).toBe('E3');
    expect(est!.confidence).toBeGreaterThan(0.2);
  });

  it('returns null when there is almost no voicing', () => {
    expect(estimateTonicHz([220, 220, null, null])).toBeNull();
  });
});

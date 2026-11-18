import { describe, expect, it } from 'vitest';
import { centsBetween, foldToReference, isOctaveJump, OctaveStabilizer } from './octave';

describe('octave folding', () => {
  it('folds a doubled frequency back to the reference', () => {
    expect(foldToReference(440, 220)).toBeCloseTo(220, 6);
    expect(foldToReference(110, 220)).toBeCloseTo(220, 6);
  });

  it('detects octave jumps but not neighbouring swaras', () => {
    expect(isOctaveJump(440, 220)).toBe(true);
    expect(isOctaveJump(233, 220)).toBe(false);
  });

  it('corrects brief YIN octave flicker and allows a held register change', () => {
    const stab = new OctaveStabilizer(200);
    expect(stab.update(0, 220)).toBeCloseTo(220, 5);
    const flickered = stab.update(20, 440);
    expect(Math.abs(centsBetween(flickered!, 220))).toBeLessThan(50);
    expect(stab.update(40, 220)).toBeCloseTo(220, 5);

    expect(stab.update(300, 440)).toBeCloseTo(220, 5); // not confirmed yet
    const held = stab.update(520, 440);
    expect(held).toBeCloseTo(440, 5);
  });

  it('does not let a two-octave onset spike fold the next real note down', () => {
    const stab = new OctaveStabilizer(220);
    let out = 0;
    for (let t = 0; t <= 400; t += 16) out = stab.update(t, 392)!;
    expect(out).toBeCloseTo(392, 0);
    const spiked = stab.update(416, 130.8);
    expect(Math.abs(centsBetween(spiked!, 392))).toBeLessThan(700);
    for (let t = 432; t <= 700; t += 16) out = stab.update(t, 523.25)!;
    expect(out).toBeCloseTo(523.25, 0);
  });
});

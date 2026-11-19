import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEVEL,
  defaultForgiving,
  intonationHint,
  LEVELS,
  LEVEL_STORAGE_KEY,
  parseStoredLevel,
  readStoredLevel,
  settingsFor,
  writeStoredLevel,
} from './levels';

describe('skill levels', () => {
  it('defaults to beginner and rejects unknown stored values', () => {
    expect(parseStoredLevel(null)).toBe('beginner');
    expect(parseStoredLevel('expert')).toBe('beginner');
    expect(parseStoredLevel('advanced')).toBe('advanced');
    expect(DEFAULT_LEVEL).toBe('beginner');
  });

  it('uses a wider snap for beginner and a short hold so notes appear quickly', () => {
    const b = settingsFor('beginner', false);
    const i = settingsFor('intermediate', false);
    const a = settingsFor('advanced', false);
    expect(b.snapCents).toBe(50);
    expect(i.snapCents).toBe(35);
    expect(a.snapCents).toBe(20);
    expect(b.notationHoldMs).toBeLessThanOrEqual(100);
    expect(b.notationHoldMs).toBeLessThan(i.notationHoldMs);
    expect(b.hysteresisCents).toBeGreaterThan(a.hysteresisCents);
    expect(b.calibrate.inlierCents).toBeGreaterThan(a.calibrate.inlierCents);
    expect(b.centsMeter).toBe('hidden');
    expect(i.centsMeter).toBe('hint');
    expect(a.centsMeter).toBe('precise');
  });

  it('turns forgiving pitch on by default only for beginner', () => {
    expect(defaultForgiving('beginner')).toBe(true);
    expect(defaultForgiving('intermediate')).toBe(false);
    expect(defaultForgiving('advanced')).toBe(false);
    expect(settingsFor('beginner').forgiving).toBe(true);
    expect(settingsFor('intermediate').forgiving).toBe(false);
  });

  it('uses a ~40-cent window and 250 ms minimum note when forgiving at beginner', () => {
    const b = settingsFor('beginner', true);
    const i = settingsFor('intermediate', true);
    const a = settingsFor('advanced', true);
    expect(b.snapCents).toBe(40);
    expect(i.snapCents).toBeLessThan(b.snapCents);
    expect(a.snapCents).toBeLessThan(i.snapCents);
    expect(b.hysteresisCents).toBeGreaterThan(i.hysteresisCents);
    expect(i.hysteresisCents).toBeGreaterThan(a.hysteresisCents);
    for (const s of [b, i, a]) {
      expect(s.notationHoldMs).toBeGreaterThanOrEqual(250);
      expect(s.medianFrames).toBeGreaterThanOrEqual(3);
    }
    expect(settingsFor('beginner', false).medianFrames).toBe(0);
  });

  it('reads and writes the level preference through a storage adapter', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    expect(readStoredLevel(storage)).toBe('beginner');
    writeStoredLevel('intermediate', storage);
    expect(store.get(LEVEL_STORAGE_KEY)).toBe('intermediate');
    expect(readStoredLevel(storage)).toBe('intermediate');
  });

  it('labels intonation relative to the level snap window', () => {
    expect(intonationHint(10, 35)).toBe('in-tune');
    expect(intonationHint(40, 35)).toBe('sharp');
    expect(intonationHint(-40, 35)).toBe('flat');
    expect(intonationHint(40, 50)).toBe('in-tune');
    expect(LEVELS.intermediate.snapCents).toBe(35);
  });
});

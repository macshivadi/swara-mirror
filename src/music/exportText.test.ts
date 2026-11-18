import { describe, expect, it } from 'vitest';
import { formatNotationText, notationFilename, slugTitle } from './exportText';

const when = new Date(2026, 10, 17); // 17 Nov 2026, local

describe('notation text export', () => {
  it('builds a slugged filename from the title and date', () => {
    expect(notationFilename('My Palavi!', when)).toBe('swara-mirror-my-palavi-2026-11-17.txt');
    expect(notationFilename('  ', when)).toBe('swara-mirror-2026-11-17.txt');
    expect(notationFilename(undefined, when)).toBe('swara-mirror-2026-11-17.txt');
    expect(slugTitle('Rāga / scale')).toBe('r-ga-scale');
  });

  it('includes title, date, Sa, level, swara line and keyboard line', () => {
    const text = formatNotationText({
      title: 'Kalyani scale',
      date: when,
      saNote: 'C#4',
      saHz: 277.1826,
      level: 'beginner',
      swaraLine: 'S R2 G3 P',
      keyboardLine: 'C#4 D#4 F4 G#4',
    });
    expect(text).toContain('Title: Kalyani scale');
    expect(text).toContain('Date: 2026-11-17');
    expect(text).toContain('Sa: C#4 (277.2 Hz)');
    expect(text).toContain('Level: Beginner');
    expect(text).toContain('Swara: S R2 G3 P');
    expect(text).toContain('Keyboard: C#4 D#4 F4 G#4');
  });

  it('falls back when title or notation is empty', () => {
    const text = formatNotationText({
      date: when,
      saNote: 'C4',
      saHz: 261.63,
      level: 'advanced',
      swaraLine: '  ',
      keyboardLine: '',
    });
    expect(text).toContain('Title: Untitled');
    expect(text).toContain('Level: Advanced');
    expect(text).toContain('Swara: (none)');
    expect(text).toContain('Keyboard: (none)');
  });
});

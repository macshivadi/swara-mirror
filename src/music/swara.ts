/**
 * Carnatic swara mapping from a frequency relative to a user-set Sa,
 * using the common 12-semitone (equal-tempered) approximation.
 *
 * Overlapping shrutis use the more common label:
 *   2 → R2 (also G1), 3 → G2 (also R3), 9 → D2 (also N1), 10 → N2 (also D3).
 */
export const SWARA_NAMES = [
  'S',
  'R1',
  'R2',
  'G2',
  'G3',
  'M1',
  'M2',
  'P',
  'D1',
  'D2',
  'N2',
  'N3',
] as const;

export type SwaraName = (typeof SWARA_NAMES)[number];

export interface SwaraInfo {
  name: SwaraName;
  short: string;
  full: string;
  aka?: string;
}

export const SWARA_INFO: Record<SwaraName, SwaraInfo> = {
  S: { name: 'S', short: 'S', full: 'Shadja' },
  R1: { name: 'R1', short: 'R₁', full: 'Shuddha Rishabha' },
  R2: { name: 'R2', short: 'R₂', full: 'Chatusruti Rishabha', aka: 'G₁' },
  G2: { name: 'G2', short: 'G₂', full: 'Sadharana Gandhara', aka: 'R₃' },
  G3: { name: 'G3', short: 'G₃', full: 'Antara Gandhara' },
  M1: { name: 'M1', short: 'M₁', full: 'Shuddha Madhyama' },
  M2: { name: 'M2', short: 'M₂', full: 'Prati Madhyama' },
  P: { name: 'P', short: 'P', full: 'Panchama' },
  D1: { name: 'D1', short: 'D₁', full: 'Shuddha Dhaivata' },
  D2: { name: 'D2', short: 'D₂', full: 'Chatusruti Dhaivata', aka: 'N₁' },
  N2: { name: 'N2', short: 'N₂', full: 'Kaisiki Nishada', aka: 'D₃' },
  N3: { name: 'N3', short: 'N₃', full: 'Kakali Nishada' },
};

export interface PitchClass {
  swara: SwaraName;
  /** 0–11 semitones above Sa in the current octave. */
  semitone: number;
  /** 0 = madhya, −1 = mandra, +1 = tara, and so on. */
  octave: number;
  /** Cents from the nearest swara, typically in (−50, 50]. */
  cents: number;
  /** Cents from Sa (may span several octaves). */
  totalCents: number;
  frequency: number;
}

export const A4_HZ = 440;

export const WESTERN_PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export type WesternPc = (typeof WESTERN_PC)[number];

/** MIDI note 69 is A4 = 440 Hz. */
export function midiToHz(midi: number, a4: number = A4_HZ): number {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function hzToMidi(hz: number, a4: number = A4_HZ): number {
  return 69 + 12 * Math.log2(hz / a4);
}

export function westernNoteToMidi(note: string): number {
  const match = note.trim().match(/^([A-G]#?)(-?\d+)$/i);
  if (!match) {
    throw new Error(`Invalid western note: ${note}`);
  }
  const pc = match[1]!.toUpperCase() as WesternPc;
  const octave = Number(match[2]);
  const pcIndex = WESTERN_PC.indexOf(pc);
  if (pcIndex < 0) {
    throw new Error(`Invalid pitch class: ${pc}`);
  }
  // C4 is MIDI 60.
  return (octave + 1) * 12 + pcIndex;
}

export function westernNoteToHz(note: string, a4: number = A4_HZ): number {
  return midiToHz(westernNoteToMidi(note), a4);
}

export function hzToWesternNote(hz: number, a4: number = A4_HZ): { note: string; cents: number } {
  const midiFloat = hzToMidi(hz, a4);
  const midi = Math.round(midiFloat);
  const cents = (midiFloat - midi) * 100;
  const pc = WESTERN_PC[((midi % 12) + 12) % 12]!;
  const octave = Math.floor(midi / 12) - 1;
  return { note: `${pc}${octave}`, cents };
}

export function hzToSwara(frequency: number, saHz: number): PitchClass {
  if (!(frequency > 0) || !(saHz > 0)) {
    throw new Error('frequency and saHz must be positive');
  }
  const totalCents = 1200 * Math.log2(frequency / saHz);
  const nearest = Math.round(totalCents / 100);
  const cents = totalCents - nearest * 100;
  const octave = Math.floor(nearest / 12);
  const semitone = ((nearest % 12) + 12) % 12;
  const swara = SWARA_NAMES[semitone]!;
  return { swara, semitone, octave, cents, totalCents, frequency };
}

export function swaraToHz(swara: SwaraName, octave: number, saHz: number): number {
  const semitone = SWARA_NAMES.indexOf(swara);
  if (semitone < 0) throw new Error(`Unknown swara: ${swara}`);
  return saHz * 2 ** ((octave * 12 + semitone) / 12);
}

/** Western note name with octave, e.g. C#4, derived from Sa. */
export function swaraToWesternNote(swara: SwaraName, octave: number, saHz: number, a4: number = A4_HZ): string {
  return hzToWesternNote(swaraToHz(swara, octave, saHz), a4).note;
}

export function swaraToMidi(swara: SwaraName, octave: number, saHz: number, a4: number = A4_HZ): number {
  return Math.round(hzToMidi(swaraToHz(swara, octave, saHz), a4));
}

export function formatSwaraGlyph(swara: SwaraName, octave: number): string {
  const base = SWARA_INFO[swara].short;
  if (octave <= -2) return `${base}̣̣`;
  if (octave === -1) return `${base}̣`;
  if (octave === 0) return base;
  if (octave === 1) return `${base}̇`;
  return `${base}̇̇`;
}

export function formatSwaraAscii(swara: SwaraName, octave: number): string {
  const base = swara;
  if (octave < 0) return `${'.'.repeat(-octave)}${base}`;
  if (octave > 0) return `${base}${"'".repeat(octave)}`;
  return base;
}

/** Common Sa choices spanning typical vocal ranges. */
export const SA_DROPDOWN_NOTES: string[] = (() => {
  const notes: string[] = [];
  for (let oct = 2; oct <= 5; oct++) {
    for (const pc of WESTERN_PC) {
      notes.push(`${pc}${oct}`);
    }
  }
  notes.push('C6');
  return notes;
})();

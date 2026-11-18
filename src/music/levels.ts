import type { CalibrateOptions } from './calibrate';

export const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export const LEVEL_STORAGE_KEY = 'swara-mirror-level';

export interface LevelSettings {
  id: SkillLevel;
  label: string;
  /** In-tune window around a swara, in cents. */
  snapCents: number;
  hysteresisCents: number;
  displayHoldMs: number;
  notationHoldMs: number;
  notationRestMs: number;
  centsMeter: 'hidden' | 'hint' | 'precise';
  calibrate: Required<
    Pick<
      CalibrateOptions,
      'minVoicedMs' | 'minElapsedMs' | 'targetMs' | 'maxWaitMs' | 'inlierCents' | 'maxWaitMinVoicedMs'
    >
  >;
}

export const LEVELS: Record<SkillLevel, LevelSettings> = {
  beginner: {
    id: 'beginner',
    label: 'Beginner',
    snapCents: 50,
    hysteresisCents: 22,
    displayHoldMs: 70,
    // Short hold so a note appears well under 0.3s on a phone.
    notationHoldMs: 90,
    notationRestMs: 220,
    centsMeter: 'hidden',
    calibrate: {
      minVoicedMs: 450,
      minElapsedMs: 500,
      targetMs: 2000,
      maxWaitMs: 3500,
      inlierCents: 110,
      maxWaitMinVoicedMs: 400,
    },
  },
  intermediate: {
    id: 'intermediate',
    label: 'Intermediate',
    snapCents: 35,
    hysteresisCents: 16,
    displayHoldMs: 80,
    notationHoldMs: 120,
    notationRestMs: 240,
    centsMeter: 'hint',
    calibrate: {
      minVoicedMs: 700,
      minElapsedMs: 1000,
      targetMs: 3000,
      maxWaitMs: 4000,
      inlierCents: 80,
      maxWaitMinVoicedMs: 600,
    },
  },
  advanced: {
    id: 'advanced',
    label: 'Advanced',
    snapCents: 20,
    hysteresisCents: 10,
    displayHoldMs: 45,
    notationHoldMs: 100,
    notationRestMs: 200,
    centsMeter: 'precise',
    calibrate: {
      minVoicedMs: 800,
      minElapsedMs: 1200,
      targetMs: 3200,
      maxWaitMs: 4000,
      inlierCents: 55,
      maxWaitMinVoicedMs: 700,
    },
  },
};

export const DEFAULT_LEVEL: SkillLevel = 'beginner';

export function isSkillLevel(value: unknown): value is SkillLevel {
  return value === 'beginner' || value === 'intermediate' || value === 'advanced';
}

export function parseStoredLevel(value: string | null | undefined): SkillLevel {
  return isSkillLevel(value) ? value : DEFAULT_LEVEL;
}

export function readStoredLevel(storage?: Pick<Storage, 'getItem'> | null): SkillLevel {
  try {
    return parseStoredLevel(storage?.getItem(LEVEL_STORAGE_KEY));
  } catch {
    return DEFAULT_LEVEL;
  }
}

export function writeStoredLevel(level: SkillLevel, storage?: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(LEVEL_STORAGE_KEY, level);
  } catch {
    /* private mode, quota, etc. */
  }
}

export function settingsFor(level: SkillLevel): LevelSettings {
  return LEVELS[level];
}

/** Sharp / flat hint once the pitch is outside the in-tune window but still in the swara bin. */
export function intonationHint(cents: number, snapCents: number): 'in-tune' | 'sharp' | 'flat' {
  if (cents >= snapCents) return 'sharp';
  if (cents <= -snapCents) return 'flat';
  return 'in-tune';
}

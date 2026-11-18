import type { SkillLevel } from './levels';

export interface NotationExport {
  title?: string;
  date: Date;
  saNote: string;
  saHz: number;
  level: SkillLevel;
  swaraLine: string;
  keyboardLine: string;
}

const LEVEL_LABEL: Record<SkillLevel, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export function slugTitle(title: string | undefined): string {
  const slug = (title ?? '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug;
}

export function notationFilename(title: string | undefined, date: Date): string {
  const day = isoDate(date);
  const slug = slugTitle(title);
  return slug ? `swara-mirror-${slug}-${day}.txt` : `swara-mirror-${day}.txt`;
}

export function formatNotationText(input: NotationExport): string {
  const title = input.title?.trim() || 'Untitled';
  const swara = input.swaraLine.trim() || '(none)';
  const keys = input.keyboardLine.trim() || '(none)';
  return [
    `Title: ${title}`,
    `Date: ${isoDate(input.date)}`,
    `Sa: ${input.saNote} (${input.saHz.toFixed(1)} Hz)`,
    `Level: ${LEVEL_LABEL[input.level]}`,
    '',
    `Swara: ${swara}`,
    `Keyboard: ${keys}`,
    '',
  ].join('\n');
}

function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

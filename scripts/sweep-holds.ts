import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readWavFile } from './wav';
import { notateFrames, runPipeline, type PipelineFrame } from '../src/eval/pipeline';
import { formatSwaraAscii, hzToSwara, hzToWesternNote, midiToHz, type SwaraName } from '../src/music/swara';
import { LEVELS, type SkillLevel } from '../src/music/levels';
import { readFileSync } from 'node:fs';

const ROOT = join(import.meta.dirname, '..');
const DATA = join(ROOT, 'eval', 'data');
const AUDIO = join(DATA, 'Audio');
const NOTES = join(DATA, 'Annotations', 'Notes');

interface GtNote {
  startMs: number;
  endMs: number;
  hz: number;
  swara: SwaraName;
}

function parseNotes(path: string, saHz: number): GtNote[] {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => {
    const [start, hz, dur] = line.split(/[,\s]+/).map(Number);
    const startMs = (start ?? 0) * 1000;
    const pitch = hzToSwara(hz ?? 0, saHz);
    return { startMs, endMs: startMs + (dur ?? 0) * 1000, hz: hz ?? 0, swara: pitch.swara };
  });
}

function mostCommonPitchClassSa(notes: { hz: number; startMs: number; endMs: number }[]): number {
  const buckets = new Map<number, { dur: number; hzs: number[] }>();
  for (const n of notes) {
    if (!(n.hz > 0)) continue;
    const midi = 69 + 12 * Math.log2(n.hz / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const cur = buckets.get(pc) ?? { dur: 0, hzs: [] };
    cur.dur += Math.max(0, n.endMs - n.startMs);
    cur.hzs.push(n.hz);
    buckets.set(pc, cur);
  }
  let best: { dur: number; hzs: number[] } | null = null;
  for (const b of buckets.values()) if (!best || b.dur > best.dur) best = b;
  if (!best?.hzs.length) return midiToHz(60);
  const target = best.hzs[0]!;
  const folded = best.hzs.map((hz) => {
    let f = hz;
    while (f > target * Math.SQRT2) f /= 2;
    while (f < target / Math.SQRT2) f *= 2;
    return f;
  });
  return [...folded].sort((a, b) => a - b)[Math.floor(folded.length / 2)]!;
}

function score(
  events: { type: string; swara?: SwaraName; startMs: number; durationMs?: number }[],
  a1: GtNote[],
  compareHoldMs: number,
): { missed: number; spurious: number; pred: number; gt: number } {
  const pred = events
    .filter((e) => e.type === 'note' && e.swara)
    .map((e) => ({ swara: e.swara!, startMs: e.startMs, endMs: e.startMs + (e.durationMs ?? 0) }));
  let spurious = 0;
  for (const p of pred) {
    const overlap = a1.some(
      (g) => g.swara === p.swara && Math.min(g.endMs, p.endMs) - Math.max(g.startMs, p.startMs) > 40,
    );
    if (!overlap || p.endMs - p.startMs < compareHoldMs) {
      if (!overlap) spurious++;
    }
  }
  // Match previous harness: a predicted note shorter than MIN is also counted spurious
  // Keep same definition as eval-singing: short pred notes count as spurious; missed uses compareHoldMs
  let missed = 0;
  for (const g of a1) {
    if (g.endMs - g.startMs < compareHoldMs) continue;
    const overlap = pred.some(
      (p) => p.swara === g.swara && Math.min(g.endMs, p.endMs) - Math.max(g.startMs, p.startMs) > 40,
    );
    if (!overlap) missed++;
  }
  // recount spurious exactly as harness (short OR no overlap)
  spurious = 0;
  for (const p of pred) {
    if (p.endMs - p.startMs < compareHoldMs) {
      spurious++;
      continue;
    }
    const overlap = a1.some(
      (g) => g.swara === p.swara && Math.min(g.endMs, p.endMs) - Math.max(g.startMs, p.startMs) > 40,
    );
    if (!overlap) spurious++;
  }
  return { missed, spurious, pred: pred.length, gt: a1.filter((g) => g.endMs - g.startMs >= compareHoldMs).length };
}

const combos: { name: string; hold: number; rest: number; hyst: number; display: number }[] = [
  { name: 'baseline-180', hold: 180, rest: 280, hyst: 18, display: 80 },
  { name: 'h100', hold: 100, rest: 200, hyst: 12, display: 50 },
  { name: 'h110', hold: 110, rest: 220, hyst: 12, display: 50 },
  { name: 'h120', hold: 120, rest: 240, hyst: 16, display: 80 },
  { name: 'h130', hold: 130, rest: 240, hyst: 16, display: 80 },
  { name: 'h140', hold: 140, rest: 300, hyst: 28, display: 140 },
  { name: 'h160', hold: 160, rest: 300, hyst: 28, display: 140 },
  { name: 'h140-hyst18', hold: 140, rest: 260, hyst: 18, display: 100 },
  { name: 'h120-hyst10', hold: 120, rest: 220, hyst: 10, display: 60 },
];

async function main() {
  if (!existsSync(AUDIO)) throw new Error('no vocadito');
  const ids = readdirSync(AUDIO)
    .map((f) => basename(f).match(/^vocadito_(\d+)\.wav$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => m[1]!)
    .sort((a, b) => Number(a) - Number(b));

  type Cache = { frames: Pick<PipelineFrame, 'timeMs' | 'frequency'>[]; saHz: number; a1raw: { hz: number; startMs: number; endMs: number }[] };
  const cache: Cache[] = [];
  console.log(`YIN pass on ${ids.length} tracks…`);
  for (const id of ids) {
    const wav = readWavFile(join(AUDIO, `vocadito_${id}.wav`));
    const rawPath = join(NOTES, `vocadito_${id}_notesA1.csv`);
    const raw = parseNotes(rawPath, 440).map((n) => ({ hz: n.hz, startMs: n.startMs, endMs: n.endMs }));
    const saHz = mostCommonPitchClassSa(raw);
    const result = runPipeline(wav.samples, wav.sampleRate, { saHz });
    cache.push({
      frames: result.frames.map((f) => ({ timeMs: f.timeMs, frequency: f.frequency })),
      saHz,
      a1raw: raw,
    });
    process.stdout.write(`  #${id} ${hzToWesternNote(saHz).note}\n`);
  }

  const rows: Record<string, { missed: number; spurious: number }[]> = {};
  const fixed180: Record<string, { missed: number; spurious: number }[]> = {};
  for (const c of combos) {
    rows[c.name] = [];
    fixed180[c.name] = [];
    for (const tr of cache) {
      const a1 = parseNotesFromRaw(tr.a1raw, tr.saHz);
      const notated = notateFrames(tr.frames, tr.saHz, {
        notationHoldMs: c.hold,
        notationRestMs: c.rest,
        hysteresisCents: c.hyst,
        displayHoldMs: c.display,
      });
      rows[c.name]!.push(score(notated.events, a1, c.hold));
      fixed180[c.name]!.push(score(notated.events, a1, 180));
    }
  }

  function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

  console.log('\nPer-combo means (eligibility = that combo hold | eligibility fixed at 180ms):');
  console.log('name'.padEnd(16), 'miss@hold', 'spur@hold', 'miss@180', 'spur@180', 'pred', 'gt@hold');
  const summary: object[] = [];
  for (const c of combos) {
    const a = rows[c.name]!;
    const b = fixed180[c.name]!;
    const line = {
      name: c.name,
      ...c,
      missedAtHold: mean(a.map((x) => x.missed)),
      spuriousAtHold: mean(a.map((x) => x.spurious)),
      missedAt180: mean(b.map((x) => x.missed)),
      spuriousAt180: mean(b.map((x) => x.spurious)),
      pred: mean(a.map((x) => x.pred)),
      gtAtHold: mean(a.map((x) => x.gt)),
    };
    summary.push(line);
    console.log(
      c.name.padEnd(16),
      line.missedAtHold.toFixed(2).padStart(8),
      line.spuriousAtHold.toFixed(2).padStart(8),
      line.missedAt180.toFixed(2).padStart(8),
      line.spuriousAt180.toFixed(2).padStart(8),
      line.pred.toFixed(1).padStart(6),
      line.gtAtHold.toFixed(1).padStart(7),
    );
  }

  // also score the three drafted levels
  console.log('\nDraft levels (own hold | fixed 180):');
  for (const id of Object.keys(LEVELS) as SkillLevel[]) {
    const L = LEVELS[id];
    const own: { missed: number; spurious: number }[] = [];
    const at180: { missed: number; spurious: number }[] = [];
    for (const tr of cache) {
      const a1 = parseNotesFromRaw(tr.a1raw, tr.saHz);
      const notated = notateFrames(tr.frames, tr.saHz, {
        notationHoldMs: L.notationHoldMs,
        notationRestMs: L.notationRestMs,
        hysteresisCents: L.hysteresisCents,
        displayHoldMs: L.displayHoldMs,
      });
      own.push(score(notated.events, a1, L.notationHoldMs));
      at180.push(score(notated.events, a1, 180));
    }
    console.log(
      id.padEnd(16),
      `hold=${L.notationHoldMs}`,
      'miss', mean(own.map((x) => x.missed)).toFixed(2),
      'spur', mean(own.map((x) => x.spurious)).toFixed(2),
      '| @180 miss', mean(at180.map((x) => x.missed)).toFixed(2),
      'spur', mean(at180.map((x) => x.spurious)).toFixed(2),
    );
  }
  writeFileSync(join(ROOT, 'eval', 'data', 'sweep-holds.json'), JSON.stringify(summary, null, 2));
}

function parseNotesFromRaw(raw: { hz: number; startMs: number; endMs: number }[], saHz: number): GtNote[] {
  return raw.map((n) => {
    const pitch = hzToSwara(n.hz, saHz);
    return { ...n, swara: pitch.swara };
  });
}

void main();

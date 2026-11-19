import {
  formatSwaraAscii,
  formatSwaraGlyph,
  hzToSwara,
  swaraToHz,
  swaraToWesternNote,
  type PitchClass,
  type SwaraName,
} from './swara';

export type NoteEvent = {
  type: 'note';
  swara: SwaraName;
  octave: number;
  startMs: number;
  durationMs: number;
};

export type RestEvent = {
  type: 'rest';
  startMs: number;
  durationMs: number;
};

export type NotationEvent = NoteEvent | RestEvent;

export interface NotationOptions {
  /** How long a swara must be held before it is written down. */
  holdMs?: number;
  /** How long a silence must last before a gap is written. */
  restMs?: number;
}

const DEFAULT_HOLD_MS = 160;
const DEFAULT_REST_MS = 280;

function samePitch(a: { swara: SwaraName; octave: number }, b: { swara: SwaraName; octave: number }): boolean {
  return a.swara === b.swara && a.octave === b.octave;
}

/**
 * Turns a stream of (possibly jittery) pitch readings into a stable
 * notation strip. Feed it regularly with `update`; pass null when unvoiced.
 */
export class NotationCollector {
  private holdMs: number;
  private restMs: number;
  private events: NotationEvent[] = [];
  private candidate: { swara: SwaraName; octave: number; sinceMs: number } | null = null;
  private unvoicedSinceMs: number | null = null;

  constructor(options: NotationOptions = {}) {
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    this.restMs = options.restMs ?? DEFAULT_REST_MS;
  }

  update(timeMs: number, pitch: Pick<PitchClass, 'swara' | 'octave'> | null): void {
    if (pitch) {
      this.onVoiced(timeMs, pitch);
    } else {
      this.onUnvoiced(timeMs);
    }
  }

  getEvents(): readonly NotationEvent[] {
    return this.events;
  }

  /** Glyph form, e.g. "S R₂ G₃ - P D₂ Ṡ" */
  toGlyphText(): string {
    return this.events
      .map((e) => (e.type === 'rest' ? '-' : formatSwaraGlyph(e.swara, e.octave)))
      .join(' ');
  }

  /** ASCII form, e.g. "S R2 G3 - P D2 S'" */
  toAsciiText(): string {
    return this.events
      .map((e) => (e.type === 'rest' ? '-' : formatSwaraAscii(e.swara, e.octave)))
      .join(' ');
  }

  setTiming(options: NotationOptions): void {
    if (options.holdMs !== undefined) this.holdMs = options.holdMs;
    if (options.restMs !== undefined) this.restMs = options.restMs;
  }

  /** Rewrites captured swaras after Sa changes, keeping the same sung pitches. */
  remapSa(fromSaHz: number, toSaHz: number): void {
    if (!(fromSaHz > 0) || !(toSaHz > 0)) return;
    const remap = (swara: SwaraName, octave: number) => {
      const next = hzToSwara(swaraToHz(swara, octave, fromSaHz), toSaHz);
      return { swara: next.swara, octave: next.octave };
    };
    this.events = this.events.map((ev) => (ev.type === 'note' ? { ...ev, ...remap(ev.swara, ev.octave) } : ev));
    if (this.candidate) this.candidate = { ...this.candidate, ...remap(this.candidate.swara, this.candidate.octave) };
  }

  clear(): void {
    this.events = [];
    this.candidate = null;
    this.unvoicedSinceMs = null;
  }

  private lastNote(): NoteEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!;
      if (ev.type === 'note') return ev;
    }
    return null;
  }

  private lastEvent(): NotationEvent | null {
    return this.events[this.events.length - 1] ?? null;
  }

  private onVoiced(timeMs: number, pitch: { swara: SwaraName; octave: number }): void {
    this.unvoicedSinceMs = null;

    const last = this.lastEvent();
    if (last?.type === 'note' && samePitch(last, pitch)) {
      last.durationMs = timeMs - last.startMs;
      this.candidate = { ...pitch, sinceMs: timeMs };
      return;
    }

    if (!this.candidate || !samePitch(this.candidate, pitch)) {
      this.candidate = { ...pitch, sinceMs: timeMs };
      return;
    }

    if (timeMs - this.candidate.sinceMs >= this.holdMs) {
      this.events.push({
        type: 'note',
        swara: pitch.swara,
        octave: pitch.octave,
        startMs: this.candidate.sinceMs,
        durationMs: timeMs - this.candidate.sinceMs,
      });
    }
  }

  private onUnvoiced(timeMs: number): void {
    this.candidate = null;
    const last = this.lastNote();
    if (!last) return;

    const trailing = this.lastEvent();
    if (trailing?.type === 'rest') {
      trailing.durationMs = timeMs - trailing.startMs;
      return;
    }

    if (this.unvoicedSinceMs === null) {
      this.unvoicedSinceMs = timeMs;
      return;
    }

    if (timeMs - this.unvoicedSinceMs >= this.restMs) {
      this.events.push({
        type: 'rest',
        startMs: this.unvoicedSinceMs,
        durationMs: timeMs - this.unvoicedSinceMs,
      });
      this.unvoicedSinceMs = null;
    }
  }
}

/**
 * Hold a displayed swara steady unless a new one is consistent for `holdMs`,
 * which tames gamaka wobble without feeling laggy.
 */
export class DisplaySmoother {
  private current: PitchClass | null = null;
  private pending: { pitch: PitchClass; sinceMs: number } | null = null;

  constructor(private holdMs: number = 80) {}

  setHoldMs(holdMs: number): void {
    this.holdMs = holdMs;
  }

  update(timeMs: number, pitch: PitchClass | null): PitchClass | null {
    if (!pitch) {
      this.pending = null;
      this.current = null;
      return null;
    }

    if (!this.current) {
      this.current = pitch;
      this.pending = null;
      return pitch;
    }

    if (this.current.swara === pitch.swara && this.current.octave === pitch.octave) {
      this.current = pitch;
      this.pending = null;
      return this.current;
    }

    if (!this.pending || this.pending.pitch.swara !== pitch.swara || this.pending.pitch.octave !== pitch.octave) {
      this.pending = { pitch, sinceMs: timeMs };
      return this.current;
    }

    const jump = Math.abs(
      (pitch.octave * 12 + pitch.semitone) - (this.current.octave * 12 + this.current.semitone),
    );
    // Neighbour wobble uses the full hold; a leap of a third or more switches quickly.
    const needed = jump >= 2 ? Math.min(this.holdMs, 30) : this.holdMs;
    if (timeMs - this.pending.sinceMs >= needed) {
      this.current = pitch;
      this.pending = null;
      return this.current;
    }

    // Still holding the previous swara, but expose the latest cents if close.
    return this.current;
  }

  reset(): void {
    this.current = null;
    this.pending = null;
  }
}


/**
 * Stay on the previous swara until the new one is clearly past the
 * boundary, so brief consonant onsets and gamaka wobble don't spawn
 * neighbour notes.
 */
export function withHysteresis(
  prev: PitchClass | null,
  next: PitchClass,
  hysteresisCents = 18,
  escapeCents = 90,
): PitchClass {
  if (!prev) return next;
  if (prev.swara === next.swara && prev.octave === next.octave) return next;
  const prevCenter = (prev.octave * 12 + prev.semitone) * 100;
  const dist = Math.abs(next.totalCents - prevCenter);
  // A real leap must leave immediately, even if a wide stay-window would
  // otherwise keep the old label (forgiving mode uses 50+32 = 82 cents).
  if (dist >= escapeCents) return next;
  if (dist < 50 + hysteresisCents) {
    return {
      ...prev,
      frequency: next.frequency,
      totalCents: next.totalCents,
      cents: next.totalCents - prevCenter,
    };
  }
  return next;
}

/** ASCII tokens without rests, merging immediate repeats. */
export function compactSwaraSequence(events: readonly NotationEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'note') continue;
    const tok = formatSwaraAscii(ev.swara, ev.octave);
    if (out[out.length - 1] !== tok) out.push(tok);
  }
  return out;
}


export type NotationFormat = 'swara' | 'keyboard' | 'both';

export function formatNoteEvent(
  ev: NoteEvent,
  saHz: number,
  format: NotationFormat,
): string {
  const sw = formatSwaraGlyph(ev.swara, ev.octave);
  if (format === 'swara') return sw;
  const key = swaraToWesternNote(ev.swara, ev.octave, saHz);
  if (format === 'keyboard') return key;
  return `${sw} (${key})`;
}

export function formatNotationLine(
  events: readonly NotationEvent[],
  saHz: number,
  format: NotationFormat,
): string {
  return events
    .map((e) => (e.type === 'rest' ? '-' : formatNoteEvent(e, saHz, format)))
    .join(' ');
}

export function formatKeyboardAscii(
  events: readonly NotationEvent[],
  saHz: number,
): string {
  return events
    .map((e) => (e.type === 'rest' ? '-' : swaraToWesternNote(e.swara, e.octave, saHz)))
    .join(' ');
}


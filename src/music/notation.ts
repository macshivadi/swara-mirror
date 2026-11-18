import {
  formatSwaraAscii,
  formatSwaraGlyph,
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
  private readonly holdMs: number;
  private readonly restMs: number;
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

  constructor(private readonly holdMs: number = 80) {}

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

    if (timeMs - this.pending.sinceMs >= this.holdMs) {
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

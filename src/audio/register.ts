import { median } from './octave';

/**
 * Whistle register is well above typical singing. C6 is ~1047 Hz; enter
 * just below that so a whistled ABC starting on C6 is caught from the
 * first note, while soprano/child singing below 1 kHz stays in voice mode.
 */
export const WHISTLE_ENTER_HZ = 1000;
export const WHISTLE_EXIT_HZ = 800;
export const WHISTLE_CONFIRM_MS = 90;

/** Two-octave keyboard centered on Sa: Sa−12 … Sa+12. */
export function keyboardRangeHz(saHz: number): { minHz: number; maxHz: number } {
  return { minHz: saHz / 2, maxHz: saHz * 2 };
}

/**
 * How many octaves to shift `hz` down (positive) or up (negative) so it
 * lands on the keyboard around Sa, preferring the octave closer to Sa
 * when both are in range.
 */
export function octaveShiftToKeyboard(hz: number, saHz: number): number {
  if (!(hz > 0) || !(saHz > 0)) return 0;
  const { minHz, maxHz } = keyboardRangeHz(saHz);
  let f = hz;
  let shift = 0;
  while (f > maxHz && shift < 8) {
    f /= 2;
    shift += 1;
  }
  while (f < minHz && shift > -4) {
    f *= 2;
    shift -= 1;
  }
  if (shift > 0 && f / 2 >= minHz) {
    const down = f / 2;
    if (Math.abs(Math.log2(down / saHz)) < Math.abs(Math.log2(f / saHz))) {
      shift += 1;
    }
  }
  if (shift < 0 && f * 2 <= maxHz) {
    const up = f * 2;
    if (Math.abs(Math.log2(up / saHz)) < Math.abs(Math.log2(f / saHz))) {
      shift -= 1;
    }
  }
  return shift;
}

export function applyOctaveShift(hz: number, shift: number): number {
  return hz / 2 ** shift;
}

/**
 * Sticky whistle detector. Once a high register is confirmed, every
 * following note is folded by the *same* number of octaves so a melody
 * keeps its intervals, and playback stays on the on-screen keyboard.
 */
export class KeyboardRegister {
  private mode: 'voice' | 'whistle' = 'voice';
  private shift = 0;
  private pending: { mode: 'voice' | 'whistle'; sinceMs: number } | null = null;

  update(timeMs: number, hz: number | null, saHz: number): number | null {
    if (hz === null) {
      this.pending = null;
      return null;
    }
    const want: 'voice' | 'whistle' =
      hz >= WHISTLE_ENTER_HZ ? 'whistle' : hz <= WHISTLE_EXIT_HZ ? 'voice' : this.mode;

    if (want !== this.mode) {
      if (!this.pending || this.pending.mode !== want) {
        this.pending = { mode: want, sinceMs: timeMs };
      }
      if (timeMs - this.pending.sinceMs >= WHISTLE_CONFIRM_MS) {
        this.mode = want;
        this.shift = want === 'whistle' ? octaveShiftToKeyboard(hz, saHz) : 0;
        this.pending = null;
      }
    } else {
      this.pending = null;
    }

    return this.mode === 'whistle' ? applyOctaveShift(hz, this.shift) : hz;
  }

  isWhistle(): boolean {
    return this.mode === 'whistle';
  }

  octaveShift(): number {
    return this.mode === 'whistle' ? this.shift : 0;
  }

  reset(): void {
    this.mode = 'voice';
    this.shift = 0;
    this.pending = null;
  }
}

/** Running median of the last `size` voiced frequencies. */
export class MedianFrequencySmoother {
  private buf: number[] = [];

  constructor(private size = 5) {}

  setSize(size: number): void {
    this.size = Math.max(1, size);
    if (this.buf.length > this.size) this.buf = this.buf.slice(-this.size);
  }

  update(hz: number | null): number | null {
    if (hz === null) {
      this.buf = [];
      return null;
    }
    this.buf.push(hz);
    if (this.buf.length > this.size) this.buf.shift();
    return median(this.buf);
  }

  reset(): void {
    this.buf = [];
  }
}

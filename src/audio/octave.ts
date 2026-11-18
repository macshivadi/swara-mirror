/**
 * Fold brief YIN octave jumps back to a running reference, while still
 * allowing a real register change that holds for confirmMs.
 *
 * A one-frame subharmonic at a note boundary must not be allowed to
 * drag the reference down, or the next real note (e.g. tara Sa after
 * Panchama) gets folded with it.
 */
export function foldToReference(hz: number, refHz: number, minHz = 70, maxHz = 1200): number {
  if (!(hz > 0) || !(refHz > 0)) return hz;
  let f = hz;
  while (f > refHz * Math.SQRT2 && f / 2 >= minHz) f /= 2;
  while (f < refHz / Math.SQRT2 && f * 2 <= maxHz) f *= 2;
  return f;
}

export function centsBetween(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return Infinity;
  return 1200 * Math.log2(a / b);
}

export function isOctaveJump(hz: number, refHz: number, windowCents = 550): boolean {
  const abs = Math.abs(centsBetween(hz, refHz));
  return [1200, 2400, 3600].some((target) => Math.abs(abs - target) <= windowCents);
}

export class OctaveStabilizer {
  private ref: number | null = null;
  private pending: { hz: number; sinceMs: number } | null = null;

  constructor(private readonly confirmMs = 220) {}

  update(timeMs: number, hz: number | null): number | null {
    if (hz === null) return null;
    if (this.ref === null) {
      this.ref = hz;
      return hz;
    }

    const rawCents = Math.abs(centsBetween(hz, this.ref));

    if (isOctaveJump(hz, this.ref)) {
      return this.considerLeap(timeMs, hz, foldToReference(hz, this.ref));
    }

    // Large non-octave spikes (messy onsets, 3rd-harmonic errors) should
    // not move the reference until they hold.
    if (rawCents > 900) {
      return this.considerLeap(timeMs, hz, this.ref);
    }

    this.pending = null;
    this.ref = this.ref * 0.6 + hz * 0.4;
    return hz;
  }

  private considerLeap(timeMs: number, rawHz: number, folded: number): number {
    if (!this.pending || Math.abs(centsBetween(this.pending.hz, rawHz)) > 200) {
      this.pending = { hz: rawHz, sinceMs: timeMs };
    }
    if (timeMs - this.pending.sinceMs >= this.confirmMs) {
      this.ref = rawHz;
      this.pending = null;
      return rawHz;
    }
    // Keep the reference in the current register; only ease toward the fold.
    this.ref = this.ref! * 0.95 + folded * 0.05;
    return folded;
  }

  reset(): void {
    this.ref = null;
    this.pending = null;
  }

  get reference(): number | null {
    return this.ref;
  }
}

/** Fold a bag of frequencies toward their median, then recompute. */
export function foldCluster(frequencies: readonly number[]): number[] {
  if (frequencies.length === 0) return [];
  const mid = median(frequencies);
  const folded = frequencies.map((hz) => foldToReference(hz, mid));
  const mid2 = median(folded);
  return folded.map((hz) => foldToReference(hz, mid2));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

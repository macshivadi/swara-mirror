import { SWARA_INFO, SWARA_NAMES, type PitchClass } from '../music/swara';

export interface StaffSample {
  timeMs: number;
  totalCents: number;
  voiced: boolean;
}

const WINDOW_MS = 8000;
const MIN_CENTS = -1400; // a bit below mandra S
const MAX_CENTS = 1600; // a bit above tara G

export class SwaraStaff {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private samples: StaffSample[] = [];
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.canvas = canvas;
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }

  push(sample: StaffSample): void {
    this.samples.push(sample);
    const cutoff = sample.timeMs - WINDOW_MS - 200;
    while (this.samples.length && this.samples[0]!.timeMs < cutoff) {
      this.samples.shift();
    }
  }

  clear(): void {
    this.samples = [];
  }

  draw(nowMs: number, current: PitchClass | null): void {
    const { ctx, width, height, dpr } = this;
    ctx.clearRect(0, 0, width, height);

    const padL = 36 * dpr;
    const padR = 12 * dpr;
    const padT = 12 * dpr;
    const padB = 12 * dpr;

    this.drawGrid(padL, padT, width - padR, height - padB);

    const xAt = (t: number) => {
      const u = (t - (nowMs - WINDOW_MS)) / WINDOW_MS;
      return padL + u * (width - padR - padL);
    };
    const yAt = (totalCents: number) => {
      const u = (totalCents - MAX_CENTS) / (MIN_CENTS - MAX_CENTS);
      return padT + u * (height - padB - padT);
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, width - padR - padL, height - padB - padT);
    ctx.clip();

    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    let drawing = false;
    ctx.beginPath();
    for (const s of this.samples) {
      if (!s.voiced) {
        drawing = false;
        continue;
      }
      const x = xAt(s.timeMs);
      const y = yAt(s.totalCents);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = '#c45c14';
    ctx.stroke();

    if (current) {
      const x = xAt(nowMs);
      const y = yAt(current.totalCents);
      ctx.fillStyle = '#9a3412';
      ctx.beginPath();
      ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff7ed';
      ctx.beginPath();
      ctx.arc(x, y, 2 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // "now" marker
    const nowX = xAt(nowMs);
    ctx.strokeStyle = 'rgba(120, 53, 15, 0.25)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(nowX, padT);
    ctx.lineTo(nowX, height - padB);
    ctx.stroke();
  }

  private drawGrid(x0: number, y0: number, x1: number, y1: number): void {
    const { ctx, dpr } = this;
    const yAt = (totalCents: number) => {
      const u = (totalCents - MAX_CENTS) / (MIN_CENTS - MAX_CENTS);
      return y0 + u * (y1 - y0);
    };

    ctx.save();
    ctx.font = `${11 * dpr}px "Source Sans 3", "Noto Sans", sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let octave = -1; octave <= 1; octave++) {
      for (let s = 0; s < 12; s++) {
        const cents = (octave * 12 + s) * 100;
        const y = yAt(cents);
        const isS = s === 0;
        const isP = s === 7;
        ctx.strokeStyle = isS
          ? 'rgba(68, 41, 22, 0.28)'
          : isP
            ? 'rgba(68, 41, 22, 0.16)'
            : 'rgba(68, 41, 22, 0.06)';
        ctx.lineWidth = (isS ? 1.25 : 1) * dpr;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();

        if (isS || isP) {
          const name = SWARA_INFO[SWARA_NAMES[s]!].short;
          const label = octave === -1 ? `${name}̣` : octave === 1 ? `${name}̇` : name;
          ctx.fillStyle = 'rgba(68, 41, 22, 0.55)';
          ctx.fillText(label, x0 - 6 * dpr, y);
        }
      }
    }
    ctx.restore();
  }
}

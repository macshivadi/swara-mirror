import { hzToMidi, midiToHz, WESTERN_PC } from '../music/swara';

export interface PianoOptions {
  onPlay: (midi: number, note: string, frequency: number) => void;
}

const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);

function isWhite(midi: number): boolean {
  return WHITE_PC.has(((midi % 12) + 12) % 12);
}

function noteName(midi: number): string {
  const pc = WESTERN_PC[((midi % 12) + 12) % 12]!;
  const octave = Math.floor(midi / 12) - 1;
  return `${pc}${octave}`;
}

/**
 * A compact 2-octave keyboard centered on Sa (Sa−12 … Sa+12).
 */
export class PianoKeyboard {
  private root: HTMLElement;
  private onPlay: PianoOptions['onPlay'];
  private saMidi = 61; // C#4 default
  private liveMidi: number | null = null;
  private stepMidi: number | null = null;
  private keys = new Map<number, HTMLButtonElement>();

  constructor(root: HTMLElement, options: PianoOptions) {
    this.root = root;
    this.onPlay = options.onPlay;
    this.render();
  }

  setSaHz(saHz: number): void {
    const next = Math.round(hzToMidi(saHz));
    if (next === this.saMidi) return;
    this.saMidi = next;
    this.render();
  }

  setLiveMidi(midi: number | null): void {
    if (midi === this.liveMidi) return;
    this.liveMidi = midi;
    this.syncHighlights();
  }

  setStepMidi(midi: number | null): void {
    if (midi === this.stepMidi) return;
    this.stepMidi = midi;
    this.syncHighlights();
  }

  get range(): { from: number; to: number; sa: number } {
    return { from: this.saMidi - 12, to: this.saMidi + 12, sa: this.saMidi };
  }

  private render(): void {
    const from = this.saMidi - 12;
    const to = this.saMidi + 12;
    const whites: number[] = [];
    const blacks: number[] = [];
    for (let m = from; m <= to; m++) {
      if (isWhite(m)) whites.push(m);
      else blacks.push(m);
    }
    this.root.innerHTML = '';
    this.root.classList.add('piano');
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Two-octave keyboard around Sa');

    const whiteRow = document.createElement('div');
    whiteRow.className = 'piano-whites';
    const blackRow = document.createElement('div');
    blackRow.className = 'piano-blacks';

    this.keys.clear();
    const whiteWidth = 100 / whites.length;

    whites.forEach((midi, i) => {
      const btn = this.makeKey(midi, 'white');
      btn.style.flex = '1';
      whiteRow.append(btn);
      this.keys.set(midi, btn);
      void i;
    });

    blacks.forEach((midi) => {
      const btn = this.makeKey(midi, 'black');
      // Place the black key over the gap between its surrounding whites.
      const leftWhites = whites.filter((w) => w < midi).length;
      btn.style.left = `calc(${leftWhites * whiteWidth}% - 0.7em)`;
      btn.style.width = `calc(${whiteWidth}% * 0.62)`;
      blackRow.append(btn);
      this.keys.set(midi, btn);
    });

    this.root.append(whiteRow, blackRow);
    this.syncHighlights();
  }

  private makeKey(midi: number, kind: 'white' | 'black'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `piano-key piano-key-${kind}`;
    btn.dataset.midi = String(midi);
    const name = noteName(midi);
    btn.setAttribute('aria-label', name);
    btn.title = name;
    if (midi === this.saMidi) {
      btn.classList.add('is-sa');
      const tag = document.createElement('span');
      tag.className = 'piano-sa-tag';
      tag.textContent = 'Sa';
      btn.append(tag);
    }
    const start = (ev: Event) => {
      ev.preventDefault();
      this.onPlay(midi, name, midiToHz(midi));
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') start(ev);
    });
    return btn;
  }

  private syncHighlights(): void {
    for (const [midi, btn] of this.keys) {
      btn.classList.toggle('is-live', this.liveMidi === midi);
      btn.classList.toggle('is-step', this.stepMidi === midi && this.stepMidi !== this.liveMidi);
      btn.classList.toggle('is-sa', midi === this.saMidi);
    }
  }
}

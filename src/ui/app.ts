import { PitchTracker } from '../audio/pitchTracker';
import { DisplaySmoother, NotationCollector } from '../music/notation';
import {
  hzToSwara,
  hzToWesternNote,
  SA_DROPDOWN_NOTES,
  SWARA_INFO,
  westernNoteToHz,
  type PitchClass,
} from '../music/swara';
import { playNotation } from '../playback/synth';
import { SwaraStaff } from './canvasStaff';

export interface MirrorState {
  listening: boolean;
  calibrating: boolean;
  saHz: number;
  saNote: string;
  frequency: number | null;
  pitch: PitchClass | null;
  notationAscii: string;
  notationGlyph: string;
  error: string | null;
}

export interface SwaraMirrorApi {
  setSaHz: (hz: number) => void;
  injectHz: (hz: number | null) => void;
  startTestTone: (hz: number) => Promise<void>;
  setTestToneHz: (hz: number) => void;
  stopTestTone: () => void;
  startListening: (mode?: 'mic' | 'silent') => Promise<void>;
  stopListening: () => void;
  getState: () => MirrorState;
  getNotationAscii: () => string;
  clearNotation: () => void;
}

declare global {
  interface Window {
    __swaraMirror?: SwaraMirrorApi;
  }
}

const DEFAULT_SA = 'C#4';

export function mountApp(root: HTMLElement): SwaraMirrorApi {
  root.innerHTML = layout();

  const tracker = new PitchTracker();
  const collector = new NotationCollector({ holdMs: 160, restMs: 280 });
  const smoother = new DisplaySmoother(80);
  const staff = new SwaraStaff(root.querySelector('#staff')!);

  let saHz = westernNoteToHz(DEFAULT_SA);
  let listening = false;
  let calibrating = false;
  let calibrateSamples: number[] = [];
  let calibrateStarted = 0;
  let lastPitch: PitchClass | null = null;
  let lastFreq: number | null = null;
  let lastError: string | null = null;
  let raf = 0;
  let playing = false;
  let stopPlayback: (() => void) | null = null;
  let useMic = true;

  const els = {
    stage: root.querySelector<HTMLElement>('.swara-stage')!,
    livePill: root.querySelector<HTMLElement>('#live-pill')!,
    big: root.querySelector<HTMLElement>('#big-swara')!,
    name: root.querySelector<HTMLElement>('#swara-name')!,
    centsNeedle: root.querySelector<HTMLElement>('#cents-needle')!,
    centsLabel: root.querySelector<HTMLElement>('#cents-label')!,
    strip: root.querySelector<HTMLElement>('#notation-strip')!,
    saSelect: root.querySelector<HTMLSelectElement>('#sa-select')!,
    saReadout: root.querySelector<HTMLElement>('#sa-readout')!,
    status: root.querySelector<HTMLElement>('#status')!,
    error: root.querySelector<HTMLElement>('#error')!,
    btnListen: root.querySelector<HTMLButtonElement>('#btn-listen')!,
    btnSa: root.querySelector<HTMLButtonElement>('#btn-set-sa')!,
    btnCopy: root.querySelector<HTMLButtonElement>('#btn-copy')!,
    btnClear: root.querySelector<HTMLButtonElement>('#btn-clear')!,
    btnPlay: root.querySelector<HTMLButtonElement>('#btn-play')!,
  };

  function fillSaDropdown(): void {
    els.saSelect.innerHTML = SA_DROPDOWN_NOTES.map((n) => {
      const hz = westernNoteToHz(n);
      const selected = n === DEFAULT_SA ? ' selected' : '';
      return `<option value="${n}"${selected}>${n} · ${hz.toFixed(1)} Hz</option>`;
    }).join('');
  }

  function setSa(hz: number, fromNote?: string): void {
    saHz = hz;
    const nearest = fromNote ?? hzToWesternNote(hz).note;
    if (SA_DROPDOWN_NOTES.includes(nearest)) {
      els.saSelect.value = nearest;
    }
    updateSaReadout();
  }

  function updateSaReadout(): void {
    const { note, cents } = hzToWesternNote(saHz);
    const centsBit = Math.abs(cents) >= 1 ? ` (${cents > 0 ? '+' : ''}${cents.toFixed(0)}¢)` : '';
    els.saReadout.textContent = `Sa = ${saHz.toFixed(1)} Hz, near ${note}${centsBit}`;
  }

  function renderPitch(pitch: PitchClass | null, freq: number | null): void {
    lastPitch = pitch;
    lastFreq = freq;
    if (!pitch) {
      els.big.innerHTML = listening ? '—' : 'S';
      els.name.textContent = listening
        ? 'Listening for your voice…'
        : calibrating
          ? 'Sing a steady Sa'
          : 'Set your Sa, then start listening';
      els.centsNeedle.style.left = '50%';
      els.centsLabel.textContent = freq ? `${freq.toFixed(1)} Hz` : '— cents';
      return;
    }
    els.big.innerHTML = renderBigGlyph(pitch);
    const info = SWARA_INFO[pitch.swara];
    const aka = info.aka ? ` · also ${info.aka}` : '';
    els.name.textContent = `${info.full}${aka}`;
    const cents = Math.max(-50, Math.min(50, pitch.cents));
    els.centsNeedle.style.left = `${50 + cents}%`;
    const sign = pitch.cents > 0.5 ? '+' : pitch.cents < -0.5 ? '' : '';
    els.centsLabel.textContent = `${sign}${pitch.cents.toFixed(0)} cents · ${freq?.toFixed(1) ?? '—'} Hz`;
  }

  function renderStrip(): void {
    const text = collector.toGlyphText();
    if (!text) {
      els.strip.classList.add('empty');
      els.strip.textContent = 'Stable swaras will line up here, like S R₂ G₃ — P D₂ Ṡ';
    } else {
      els.strip.classList.remove('empty');
      els.strip.textContent = text;
    }
    const hasNotes = collector.getEvents().some((e) => e.type === 'note');
    els.btnCopy.disabled = !hasNotes;
    els.btnClear.disabled = !hasNotes && !text;
    els.btnPlay.disabled = !hasNotes && !playing;
  }

  function setError(msg: string | null): void {
    lastError = msg;
    els.error.textContent = msg ?? '';
  }

  function setListeningUi(on: boolean): void {
    els.stage.classList.toggle('live', on && !calibrating);
    els.stage.classList.toggle('calibrating', calibrating);
    els.livePill.hidden = !on;
    els.livePill.lastChild && (els.livePill.querySelector('span:last-child')!.textContent = calibrating ? 'Setting Sa' : 'Listening');
    els.btnListen.textContent = on ? 'Stop' : 'Start listening';
    els.btnListen.classList.toggle('listening', on);
    els.btnListen.classList.toggle('primary', !on);
  }

  async function startListening(mode: 'mic' | 'silent' = 'mic'): Promise<void> {
    setError(null);
    useMic = mode === 'mic';
    try {
      await tracker.ensureContext();
      if (useMic) await tracker.startMic();
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Microphone permission was denied. Allow the mic, or pick a Sa from the list.');
      } else if (name === 'NotFoundError') {
        setError('No microphone was found.');
      } else {
        setError('Could not start the microphone. Try again from a tap, on HTTPS.');
      }
      listening = false;
      setListeningUi(false);
      throw err;
    }
    listening = true;
    setListeningUi(true);
    loop();
  }

  function stopListening(): void {
    listening = false;
    calibrating = false;
    tracker.stopMic();
    cancelAnimationFrame(raf);
    setListeningUi(false);
    renderPitch(null, null);
  }

  async function startCalibration(): Promise<void> {
    setError(null);
    calibrateSamples = [];
    calibrateStarted = performance.now();
    calibrating = true;
    if (!listening) {
      try {
        await startListening('mic');
      } catch {
        calibrating = false;
        setListeningUi(false);
        return;
      }
    }
    setListeningUi(true);
    els.status.textContent = 'Sing a steady Sa for about 1½ seconds…';
  }

  function finishCalibration(now: number): void {
    calibrating = false;
    const values = calibrateSamples;
    if (values.length < 12) {
      setError('Couldn’t catch a steady note. Try a quiet room, or pick a Sa from the list.');
      els.status.textContent = '';
      setListeningUi(listening);
      return;
    }
    const median = medianOf(values);
    const centsSpread = values.map((hz) => Math.abs(1200 * Math.log2(hz / median)));
    const p90 = percentile(centsSpread, 0.9);
    if (p90 > 45) {
      setError('The pitch moved around too much. Hold one note steadily, or pick a Sa from the list.');
      els.status.textContent = '';
      setListeningUi(listening);
      return;
    }
    setSa(median);
    const { note } = hzToWesternNote(median);
    els.status.textContent = `Sa set from your voice: ${median.toFixed(1)} Hz (near ${note}).`;
    setListeningUi(listening);
    void now;
  }

  function loop(): void {
    if (!listening) return;
    const now = performance.now();
    const reading = tracker.read(now);
    const freq = reading.frequency;
    const pitch = freq ? hzToSwara(freq, saHz) : null;
    const display = smoother.update(now, pitch);

    if (calibrating) {
      if (freq) calibrateSamples.push(freq);
      if (now - calibrateStarted >= 1500) finishCalibration(now);
    } else if (pitch) {
      collector.update(now, pitch);
    } else {
      collector.update(now, null);
    }

    staff.push({ timeMs: now, totalCents: pitch?.totalCents ?? 0, voiced: Boolean(pitch) });
    staff.draw(now, display);
    renderPitch(display, freq);
    renderStrip();
    raf = requestAnimationFrame(loop);
  }

  async function onListenClick(): Promise<void> {
    await tracker.ensureContext();
    if (listening) stopListening();
    else await startListening('mic');
  }

  async function onPlay(): Promise<void> {
    if (playing) {
      stopPlayback?.();
      return;
    }
    const events = collector.getEvents();
    if (!events.length) return;
    const ctx = await tracker.ensureContext();
    playing = true;
    els.btnPlay.disabled = false;
    els.btnPlay.textContent = 'Stop playback';
    const { stopped, stop } = await playNotation(events, ctx, { saHz });
    stopPlayback = stop;
    await stopped;
    playing = false;
    stopPlayback = null;
    els.btnPlay.textContent = 'Play notation';
    renderStrip();
  }

  async function onCopy(): Promise<void> {
    const text = collector.toAsciiText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      els.status.textContent = 'Copied the notation.';
    } catch {
      els.status.textContent = text;
    }
  }

  function onClear(): void {
    if (playing) stopPlayback?.();
    collector.clear();
    staff.clear();
    smoother.reset();
    els.status.textContent = '';
    renderStrip();
  }

  fillSaDropdown();
  updateSaReadout();
  renderPitch(null, null);
  renderStrip();

  els.btnListen.addEventListener('click', () => void onListenClick());
  els.btnSa.addEventListener('click', () => void startCalibration());
  els.btnCopy.addEventListener('click', () => void onCopy());
  els.btnClear.addEventListener('click', onClear);
  els.btnPlay.addEventListener('click', () => void onPlay());
  els.saSelect.addEventListener('change', () => {
    setSa(westernNoteToHz(els.saSelect.value), els.saSelect.value);
    els.status.textContent = `Sa set to ${els.saSelect.value}.`;
  });

  const onResize = () => {
    staff.resize();
    staff.draw(performance.now(), lastPitch);
  };
  window.addEventListener('resize', onResize);

  const api: SwaraMirrorApi = {
    setSaHz: (hz) => setSa(hz),
    injectHz: (hz) => tracker.injectHz(hz),
    startTestTone: (hz) => tracker.startTestTone(hz),
    setTestToneHz: (hz) => tracker.setTestToneHz(hz),
    stopTestTone: () => tracker.stopTestTone(),
    startListening: (mode = 'silent') => startListening(mode),
    stopListening: () => stopListening(),
    getState: () => ({
      listening,
      calibrating,
      saHz,
      saNote: hzToWesternNote(saHz).note,
      frequency: lastFreq,
      pitch: lastPitch,
      notationAscii: collector.toAsciiText(),
      notationGlyph: collector.toGlyphText(),
      error: lastError,
    }),
    getNotationAscii: () => collector.toAsciiText(),
    clearNotation: () => onClear(),
  };

  window.__swaraMirror = api;
  return api;
}

function renderBigGlyph(pitch: PitchClass): string {
  const label = SWARA_INFO[pitch.swara].short;
  const above = pitch.octave > 0 ? `<span class="octave-dot above" title="tara"></span>`.repeat(Math.min(2, pitch.octave)) : '';
  const below = pitch.octave < 0 ? `<span class="octave-dot below" title="mandra"></span>`.repeat(Math.min(2, -pitch.octave)) : '';
  return `${above}${label}${below}`;
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i]!;
}

function layout(): string {
  return `
    <header class="header">
      <p class="tamil">ஸ்வர கண்ணாடி</p>
      <h1 class="english">Swara Mirror</h1>
      <p class="tagline">Sing a melody — an Ilayaraja pallavi, a scale, anything — and watch the swaras appear as you go.</p>
      <div class="gold-rule" aria-hidden="true"></div>
    </header>

    <section class="card swara-stage" aria-live="polite">
      <div id="live-pill" class="live-pill" hidden><span class="dot"></span><span>Listening</span></div>
      <p id="big-swara" class="big-swara">S</p>
      <p id="swara-name" class="swara-name"></p>
      <div class="cents-meter" aria-hidden="true">
        <div class="cents-track"></div>
        <div class="cents-center"></div>
        <div id="cents-needle" class="cents-needle" style="left: 50%"></div>
      </div>
      <div id="cents-label" class="cents-label">— cents</div>
      <div class="staff-wrap">
        <canvas id="staff" width="720" height="220" aria-label="Scrolling swara line"></canvas>
      </div>
    </section>

    <section class="card">
      <p class="notation-label">Notation</p>
      <div id="notation-strip" class="notation-strip empty"></div>
      <div class="row">
        <button id="btn-copy" type="button">Copy notation</button>
        <button id="btn-play" type="button">Play notation</button>
        <button id="btn-clear" type="button">Clear</button>
      </div>
    </section>

    <section class="card">
      <p class="notation-label">Your Sa</p>
      <div class="sa-row">
        <label>
          <span class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Pick a Sa</span>
          <select id="sa-select" aria-label="Pick a Sa"></select>
        </label>
        <button id="btn-set-sa" type="button">Set my Sa</button>
      </div>
      <p id="sa-readout" class="sa-readout"></p>
      <div class="row">
        <button id="btn-listen" class="primary" type="button">Start listening</button>
      </div>
      <p id="status" class="status"></p>
      <p id="error" class="error" role="alert"></p>
    </section>

    <p class="privacy"><strong>Your voice stays on this device.</strong> Pitch is detected in the browser. Nothing is uploaded, and no AI service is used.</p>
  `;
}

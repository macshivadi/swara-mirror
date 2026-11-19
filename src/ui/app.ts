import { PitchTracker } from '../audio/pitchTracker';
import { KeyboardRegister, MedianFrequencySmoother } from '../audio/register';
import {
  calibrationErrorMessage,
  evaluateCalibration,
  type CalibrateSample,
} from '../music/calibrate';
import { formatNotationText, notationFilename } from '../music/exportText';
import {
  defaultForgiving,
  intonationHint,
  readStoredLevel,
  settingsFor,
  writeStoredLevel,
  type SkillLevel,
} from '../music/levels';
import {
  DisplaySmoother,
  formatKeyboardAscii,
  formatNotationLine,
  NotationCollector,
  withHysteresis,
  type NotationEvent,
  type NotationFormat,
} from '../music/notation';
import {
  hzToSwara,
  hzToWesternNote,
  SA_DROPDOWN_NOTES,
  SWARA_INFO,
  swaraToMidi,
  swaraToWesternNote,
  westernNoteToHz,
  type PitchClass,
} from '../music/swara';
import { playFreq, playNotation } from '../playback/synth';
import { shouldKeepMicAfterCalibration } from './micPolicy';
import { SwaraStaff } from './canvasStaff';
import { PianoKeyboard } from './piano';

export interface MirrorState {
  listening: boolean;
  calibrating: boolean;
  saHz: number;
  saNote: string;
  frequency: number | null;
  pitch: PitchClass | null;
  westernNote: string | null;
  notationAscii: string;
  notationGlyph: string;
  keyboardLine: string;
  error: string | null;
  level: SkillLevel;
  format: NotationFormat;
  calProgress: number;
  saLocked: boolean;
  liveStatus: string;
  listenElapsedMs: number;
  inputLevel: number;
  contextState: string;
  micLive: boolean;
  wantsMic: boolean;
  forgiving: boolean;
  whistle: boolean;
}

export interface SwaraMirrorApi {
  setSaHz: (hz: number) => void;
  injectHz: (hz: number | null) => void;
  startTestTone: (hz: number) => Promise<void>;
  setTestToneHz: (hz: number) => void;
  stopTestTone: () => void;
  startListening: (mode?: 'mic' | 'silent') => Promise<void>;
  startCalibration: (mode?: 'mic' | 'silent') => Promise<void>;
  stopListening: () => void;
  setLevel: (level: SkillLevel) => void;
  setForgiving: (on: boolean) => void;
  setFormat: (format: NotationFormat) => void;
  getExportText: (title?: string, date?: Date) => string;
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

  let skillLevel: SkillLevel = readStoredLevel(window.localStorage);
  let forgiving = defaultForgiving(skillLevel);
  let level = settingsFor(skillLevel, forgiving);
  let format: NotationFormat = 'both';

  const tracker = new PitchTracker();
  const collector = new NotationCollector({ holdMs: level.notationHoldMs, restMs: level.notationRestMs });
  const smoother = new DisplaySmoother(level.displayHoldMs);
  const staff = new SwaraStaff(root.querySelector('#staff')!);
  const register = new KeyboardRegister();
  const medianSmoother = new MedianFrequencySmoother(level.medianFrames || 1);

  let saHz = westernNoteToHz(DEFAULT_SA);
  let listening = false;
  let calibrating = false;
  let calibrateSamples: CalibrateSample[] = [];
  let calibrateStarted = 0;
  let lastPitch: PitchClass | null = null;
  let stickyPitch: PitchClass | null = null;
  let lastFreq: number | null = null;
  let lastError: string | null = null;
  let inputLevel = 0;
  let calProgress = 0;
  let raf = 0;
  let pollTimer = 0;
  let lastTick = 0;
  let saLocked = false;
  let saPrompt: 'auto' | 'manual' | null = null;
  let liveStatus = '';
  let listenStarted = 0;
  let playing = false;
  let stopPlayback: (() => void) | null = null;
  let playbackHolds = 0;
  let useMic = true;
  let stepIndex = 0;

  const els = {
    stage: root.querySelector<HTMLElement>('.swara-stage')!,
    livePill: root.querySelector<HTMLElement>('#live-pill')!,
    big: root.querySelector<HTMLElement>('#big-swara')!,
    western: root.querySelector<HTMLElement>('#western-note')!,
    name: root.querySelector<HTMLElement>('#swara-name')!,
    intonation: root.querySelector<HTMLElement>('#intonation')!,
    centsNeedle: root.querySelector<HTMLElement>('#cents-needle')!,
    centsLabel: root.querySelector<HTMLElement>('#cents-label')!,
    calPanel: root.querySelector<HTMLElement>('#cal-panel')!,
    levelFill: root.querySelector<HTMLElement>('#level-fill')!,
    calHearing: root.querySelector<HTMLElement>('#cal-hearing')!,
    calProgress: root.querySelector<HTMLElement>('#cal-progress')!,
    calProgressFill: root.querySelector<HTMLElement>('#cal-progress-fill')!,
    listenTimer: root.querySelector<HTMLElement>('#listen-timer')!,
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
    btnPrev: root.querySelector<HTMLButtonElement>('#btn-prev')!,
    btnNext: root.querySelector<HTMLButtonElement>('#btn-next')!,
    btnDownload: root.querySelector<HTMLButtonElement>('#btn-download')!,
    btnPrint: root.querySelector<HTMLButtonElement>('#btn-print')!,
    titleInput: root.querySelector<HTMLInputElement>('#song-title')!,
    stepLabel: root.querySelector<HTMLElement>('#step-label')!,
    printSheet: root.querySelector<HTMLElement>('#print-sheet')!,
    pianoHost: root.querySelector<HTMLElement>('#piano')!,
  };

  const piano = new PianoKeyboard(els.pianoHost, {
    onPlay: (midi, note, frequency) => {
      void withPlayback(async () => {
        const ctx = await tracker.ensureContext();
        piano.setStepMidi(midi);
        els.status.textContent = `Played ${note}.`;
        await playFreq(ctx, frequency, 420);
      });
    },
  });
  piano.setSaHz(saHz);

  function fillSaDropdown(): void {
    els.saSelect.innerHTML = SA_DROPDOWN_NOTES.map((n) => {
      const hz = westernNoteToHz(n);
      const selected = n === DEFAULT_SA ? ' selected' : '';
      return `<option value="${n}"${selected}>${n} · ${hz.toFixed(1)} Hz</option>`;
    }).join('');
  }

  function setSa(hz: number, fromNote?: string, lock = true): void {
    saHz = hz;
    if (lock) saLocked = true;
    stickyPitch = null;
    smoother.reset();
    const nearest = fromNote ?? hzToWesternNote(hz).note;
    if (SA_DROPDOWN_NOTES.includes(nearest)) {
      els.saSelect.value = nearest;
    }
    piano.setSaHz(saHz);
    register.reset();
    medianSmoother.reset();
    updateSaReadout();
    renderStrip();
    syncStepHighlight();
  }

  function updateSaReadout(): void {
    const { note, cents } = hzToWesternNote(saHz);
    const centsBit = Math.abs(cents) >= 1 ? ` (${cents > 0 ? '+' : ''}${cents.toFixed(0)}¢)` : '';
    els.saReadout.textContent = `Sa = ${saHz.toFixed(1)} Hz, near ${note}${centsBit}`;
  }

  function applyLevel(next: SkillLevel, persist = true, nextForgiving = defaultForgiving(next)): void {
    skillLevel = next;
    forgiving = nextForgiving;
    level = settingsFor(skillLevel, forgiving);
    collector.setTiming({ holdMs: level.notationHoldMs, restMs: level.notationRestMs });
    smoother.setHoldMs(level.displayHoldMs);
    medianSmoother.setSize(level.medianFrames || 1);
    medianSmoother.reset();
    if (persist) writeStoredLevel(skillLevel, window.localStorage);
    root.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.level === skillLevel);
      btn.setAttribute('aria-checked', btn.dataset.level === skillLevel ? 'true' : 'false');
    });
    root.querySelectorAll<HTMLButtonElement>('[data-forgiving]').forEach((btn) => {
      const on = btn.dataset.forgiving === 'on';
      btn.classList.toggle('is-on', on === forgiving);
      btn.setAttribute('aria-checked', on === forgiving ? 'true' : 'false');
    });
    els.stage.classList.toggle('cents-hidden', level.centsMeter === 'hidden');
  }

  function applyFormat(next: NotationFormat): void {
    format = next;
    root.querySelectorAll<HTMLButtonElement>('[data-format]').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.format === format);
      btn.setAttribute('aria-checked', btn.dataset.format === format ? 'true' : 'false');
    });
    renderStrip();
  }

  function noteEvents(): Extract<NotationEvent, { type: 'note' }>[] {
    return collector.getEvents().filter((e): e is Extract<NotationEvent, { type: 'note' }> => e.type === 'note');
  }

  function syncStepHighlight(): void {
    const notes = noteEvents();
    if (!notes.length) {
      piano.setStepMidi(null);
      els.stepLabel.textContent = 'Play or step through the captured notation to see the next key.';
      els.btnPrev.disabled = true;
      els.btnNext.disabled = true;
      return;
    }
    stepIndex = Math.max(0, Math.min(stepIndex, notes.length - 1));
    const ev = notes[stepIndex]!;
    piano.setStepMidi(swaraToMidi(ev.swara, ev.octave, saHz));
    const sw = ev.swara;
    const key = swaraToWesternNote(ev.swara, ev.octave, saHz);
    els.stepLabel.textContent = `Next key ${stepIndex + 1} of ${notes.length}: ${sw} (${key})`;
    els.btnPrev.disabled = stepIndex <= 0;
    els.btnNext.disabled = stepIndex >= notes.length - 1;
  }

  function renderPitch(pitch: PitchClass | null, freq: number | null): void {
    lastPitch = pitch;
    lastFreq = freq;
    if (!pitch) {
      els.big.innerHTML = listening ? '—' : 'S';
      els.western.textContent = listening ? '' : hzToWesternNote(saHz).note;
      els.name.textContent = calibrating
        ? 'Sing a steady Sa'
        : listening
          ? 'Listening for your voice…'
          : 'Set your Sa, then start listening';
      els.intonation.textContent = '';
      els.centsNeedle.style.left = '50%';
      els.centsLabel.textContent = freq ? `${freq.toFixed(1)} Hz` : '— cents';
      piano.setLiveMidi(null);
      return;
    }
    els.big.innerHTML = renderBigGlyph(pitch);
    const western = swaraToWesternNote(pitch.swara, pitch.octave, saHz);
    els.western.textContent = western;
    piano.setLiveMidi(swaraToMidi(pitch.swara, pitch.octave, saHz));
    const info = SWARA_INFO[pitch.swara];
    const aka = info.aka ? ` · also ${info.aka}` : '';
    els.name.textContent = `${info.full}${aka} · ${western}`;
    const cents = Math.max(-50, Math.min(50, pitch.cents));
    els.centsNeedle.style.left = `${50 + cents}%`;
    const sign = pitch.cents > 0.5 ? '+' : pitch.cents < -0.5 ? '' : '';
    const hint = intonationHint(pitch.cents, level.snapCents);
    if (level.centsMeter === 'hidden') {
      els.centsLabel.textContent = western;
      els.intonation.textContent = '';
    } else if (level.centsMeter === 'hint') {
      els.centsLabel.textContent = `${sign}${pitch.cents.toFixed(0)} cents · ${freq?.toFixed(1) ?? '—'} Hz`;
      els.intonation.textContent = hint === 'sharp' ? 'A little sharp' : hint === 'flat' ? 'A little flat' : 'In tune';
    } else {
      els.centsLabel.textContent = `${sign}${pitch.cents.toFixed(0)} cents · ${freq?.toFixed(1) ?? '—'} Hz`;
      els.intonation.textContent = hint === 'in-tune' ? 'In tune' : hint === 'sharp' ? 'Sharp' : 'Flat';
    }
  }

  function renderStrip(): void {
    const events = collector.getEvents();
    const text = formatNotationLine(events, saHz, format);
    if (!text) {
      els.strip.classList.add('empty');
      els.strip.textContent = 'Stable swaras will line up here, like S (C#4)  R₂ (D#4)  —  P (G#4)';
    } else {
      els.strip.classList.remove('empty');
      els.strip.textContent = text;
    }
    const hasNotes = events.some((e) => e.type === 'note');
    els.btnCopy.disabled = !hasNotes;
    els.btnClear.disabled = !hasNotes && !text;
    els.btnPlay.disabled = !hasNotes && !playing;
    els.btnDownload.disabled = !hasNotes;
    els.btnPrint.disabled = !hasNotes;
    syncStepHighlight();
  }

  function setError(msg: string | null): void {
    lastError = msg;
    els.error.textContent = msg ?? '';
  }

  function setLiveStatus(msg: string): void {
    liveStatus = msg;
    els.calHearing.textContent = msg;
  }

  function updateLiveMeter(meter: number, freq: number | null): void {
    els.calPanel.hidden = !listening && !calibrating;
    els.levelFill.style.width = `${Math.round(meter * 100)}%`;
    if (!listening && !calibrating) return;
    if (!listening && calibrating) {
      if (freq) setLiveStatus(`Hearing a note near ${freq.toFixed(0)} Hz`);
      else setLiveStatus('Sing a steady note — I’ll use it as Sa.');
      return;
    }
    if (meter < 0.1 && !freq) {
      setLiveStatus('Too quiet — move closer');
    } else if (!saLocked) {
      if (freq) setLiveStatus(`Listening… finding your Sa (~${freq.toFixed(0)} Hz)`);
      else setLiveStatus('Listening… sing now');
    } else if (freq) {
      setLiveStatus('Listening… sing now');
    } else if (meter < 0.14) {
      setLiveStatus('Too quiet — move closer');
    } else {
      setLiveStatus('Listening… sing now');
    }
  }

  function setListeningUi(on: boolean): void {
    els.stage.classList.toggle('live', on);
    els.stage.classList.toggle('calibrating', on && !saLocked);
    els.livePill.hidden = !on;
    const pillLabel = els.livePill.querySelector('span:last-child');
    if (pillLabel) pillLabel.textContent = 'Listening… sing now';
    els.btnListen.textContent = on ? 'Stop' : 'Tap to sing';
    els.btnListen.classList.toggle('listening', on);
    els.btnListen.classList.toggle('primary', !on);
    els.btnListen.classList.toggle('sing-btn', true);
    els.btnSa.textContent = 'Set my Sa';
    els.calPanel.hidden = !on;
    els.calProgress.hidden = !on || (saLocked && !calibrating);
    if (!on) {
      els.levelFill.style.width = '0%';
      els.calProgressFill.style.width = '0%';
      calProgress = 0;
      els.listenTimer.textContent = '0:00';
      setLiveStatus('');
    } else {
      updateListenTimer(performance.now());
    }
  }

  async function prepareAudio(mode: 'mic' | 'silent'): Promise<void> {
    useMic = mode === 'mic';
    tracker.primeFromUserGesture();
    if (useMic) await tracker.startMic();
    await tracker.resume();
  }

  function startLoop(): void {
    stopLoop();
    lastTick = 0;
    const pump = () => {
      try {
        tick(performance.now());
      } catch {
        /* keep the loop alive — a single DSP glitch must not stall listening */
      }
      if (listening || calibrating) raf = requestAnimationFrame(pump);
    };
    raf = requestAnimationFrame(pump);
    pollTimer = window.setInterval(() => {
      try {
        tick(performance.now());
      } catch {
        /* keep the loop alive */
      }
    }, 33);
  }

  function stopLoop(): void {
    cancelAnimationFrame(raf);
    raf = 0;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  async function startListening(mode: 'mic' | 'silent' = 'mic'): Promise<void> {
    setError(null);
    try {
      await prepareAudio(mode);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Microphone permission was denied. Allow the mic, or pick a Sa from the list in Settings.');
      } else if (name === 'NotFoundError') {
        setError('No microphone was found.');
      } else {
        setError('Could not start the microphone. Try again from a tap, on HTTPS.');
      }
      listening = false;
      calibrating = false;
      tracker.setMode('listen');
      setListeningUi(false);
      throw err;
    }
    // Stay in listen mode so notation and auto-Sa share one pitch stream.
    tracker.setMode('listen');
    listening = true;
    listenStarted = performance.now();
    if (!saLocked) beginAutoSa('auto');
    setListeningUi(true);
    setLiveStatus('Listening… sing now');
    startLoop();
  }

  function stopListening(): void {
    listening = false;
    calibrating = false;
    tracker.setMode('listen');
    tracker.stopMic();
    stopLoop();
    register.reset();
    medianSmoother.reset();
    setListeningUi(false);
    renderPitch(null, null);
    const hint = root.querySelector<HTMLElement>('#whistle-hint');
    if (hint) hint.hidden = true;
  }

  function beginAutoSa(kind: 'auto' | 'manual' = 'auto'): void {
    saPrompt = kind;
    calibrating = true;
    calibrateSamples = [];
    calProgress = 0;
    calibrateStarted = performance.now();
  }

  async function startCalibration(mode: 'mic' | 'silent' = 'mic'): Promise<void> {
    setError(null);
    // Borrow the mic for Sa only. Never turn this into a Tap to sing session.
    if (listening) {
      await tracker.ensureContext();
    } else {
      try {
        await prepareAudio(mode);
      } catch {
        return;
      }
      startLoop();
    }
    saLocked = false;
    beginAutoSa('manual');
    els.stage.classList.add('calibrating');
    els.calPanel.hidden = false;
    els.calProgress.hidden = false;
    setLiveStatus('Sing a steady note — I’ll use it as Sa.');
    els.status.textContent = 'Sing a steady note — I’ll use it as Sa.';
  }

  function endCalibrationMic(): void {
    if (shouldKeepMicAfterCalibration(listening)) {
      setListeningUi(true);
      return;
    }
    tracker.stopMic();
    stopLoop();
    setListeningUi(false);
  }

  function lockSaFromCalibration(result: ReturnType<typeof evaluateCalibration>): void {
    const manual = saPrompt === 'manual';
    calibrating = false;
    els.calProgressFill.style.width = '0%';
    if (!result.ok || result.snappedHz === null || result.snappedNote === null) {
      saPrompt = null;
      if (manual) {
        setError(calibrationErrorMessage(result.reason));
        saLocked = true;
      } else {
        saLocked = true;
        setLiveStatus(`Using ${hzToWesternNote(saHz).note} as Sa — change it in Settings if you like`);
      }
      endCalibrationMic();
      return;
    }
    const previousSa = saHz;
    collector.remapSa(previousSa, result.snappedHz);
    setSa(result.snappedHz, result.snappedNote, true);
    setError(null);
    const keep = shouldKeepMicAfterCalibration(listening);
    const heard = result.medianHz !== null ? `; heard ${result.medianHz.toFixed(1)} Hz` : '';
    const msg = keep
      ? `Sa set to ${result.snappedNote} (${result.snappedHz.toFixed(1)} Hz${heard}; keep singing)`
      : `Sa set to ${result.snappedNote} (${result.snappedHz.toFixed(1)} Hz${heard}).`;
    els.status.textContent = msg;
    setLiveStatus(keep ? `Sa set to ${result.snappedNote} — keep singing` : `Sa set to ${result.snappedNote}`);
    saPrompt = null;
    endCalibrationMic();
    void playSaReference(result.snappedHz);
  }

  function tick(now: number): void {
    if (!listening && !calibrating) return;
    if (now - lastTick < 12) return;
    lastTick = now;
    if (tracker.isMicHeld()) {
      // Don't write rests into notation while the mic is ducked for playback.
      updateListenTimer(now);
      return;
    }
    void tracker.resume();
    updateListenTimer(now);
    els.calProgress.hidden = saLocked && !calibrating;
    const reading = tracker.read(now);
    inputLevel = reading.level;
    let freq = register.update(now, reading.frequency, saHz);
    if (level.medianFrames > 0) freq = medianSmoother.update(freq);
    const hint = root.querySelector<HTMLElement>('#whistle-hint');
    if (hint) {
      hint.hidden = !register.isWhistle();
    }
    const classified = freq ? hzToSwara(freq, saHz) : null;
    const held = classified ? withHysteresis(stickyPitch, classified, level.hysteresisCents, level.escapeCents) : null;
    stickyPitch = held;
    const display = smoother.update(now, held);

    // Write notation only during an explicit Tap to sing session.
    if (listening) {
      if (held) collector.update(now, held);
      else collector.update(now, null);
    }

    if (!saLocked || calibrating) {
      if (freq) calibrateSamples.push({ timeMs: now, frequency: freq });
      const result = evaluateCalibration(calibrateSamples, now - calibrateStarted, level.calibrate);
      calProgress = result.progress;
      els.calProgressFill.style.width = `${Math.round(result.progress * 100)}%`;
      els.calProgress.setAttribute('aria-valuenow', String(Math.round(result.progress * 100)));
      if (result.ok || result.reason !== 'waiting') {
        lockSaFromCalibration(result);
      }
    }

    updateLiveMeter(reading.level, freq);
    staff.push({ timeMs: now, totalCents: (display ?? held)?.totalCents ?? 0, voiced: Boolean(held) });
    staff.draw(now, display);
    renderPitch(display, freq);
    renderStrip();
  }

  function updateListenTimer(now: number): void {
    const ms = listening ? Math.max(0, now - listenStarted) : 0;
    const sec = Math.floor(ms / 1000);
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, '0');
    els.listenTimer.textContent = `${mm}:${ss}`;
  }

  /**
   * Pause a live mic for the duration of piano / notation playback so iOS
   * leaves play-and-record mode (which ducks output). Resume automatically
   * afterwards if the user is still in Tap to sing — they shouldn't have to
   * tap again just because a key was pressed.
   */
  async function withPlayback<T>(fn: () => Promise<T>): Promise<T> {
    playbackHolds += 1;
    if ((listening || tracker.isMicLive() || tracker.isMicHeld()) && playbackHolds === 1) {
      tracker.pauseMic();
    }
    try {
      return await fn();
    } finally {
      playbackHolds -= 1;
      if (playbackHolds === 0 && listening) {
        try {
          await tracker.resumeMic();
        } catch {
          /* permission or device may have gone; listening UI stays on */
        }
      }
    }
  }

  async function playSaReference(hz: number): Promise<void> {
    // Always duck/stop capture first so iOS can play the tone at full volume.
    await withPlayback(async () => {
      const ctx = await tracker.ensureContext();
      await playFreq(ctx, hz, 420);
    });
  }

  async function onListenClick(): Promise<void> {
    // Create/resume the AudioContext in this tap's synchronous turn (iOS Safari).
    tracker.primeFromUserGesture();
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
    await withPlayback(async () => {
      const ctx = await tracker.ensureContext();
      playing = true;
      els.btnPlay.disabled = false;
      els.btnPlay.textContent = 'Stop playback';
      const { stopped, stop } = await playNotation(events, ctx, {
        saHz,
        onEvent: (ev) => {
          if (ev.type === 'note') {
            const notes = noteEvents();
            const idx = notes.findIndex((n) => n.startMs === ev.startMs && n.swara === ev.swara);
            if (idx >= 0) stepIndex = idx;
            piano.setStepMidi(swaraToMidi(ev.swara, ev.octave, saHz));
            syncStepHighlight();
          }
        },
      });
      stopPlayback = stop;
      await stopped;
      playing = false;
      stopPlayback = null;
      els.btnPlay.textContent = 'Play notation';
      renderStrip();
    });
  }

  async function onCopy(): Promise<void> {
    const text = buildExport(els.titleInput.value, new Date());
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
    stickyPitch = null;
    stepIndex = 0;
    piano.setStepMidi(null);
    els.status.textContent = '';
    renderStrip();
  }

  async function stepBy(delta: number, play = true): Promise<void> {
    const notes = noteEvents();
    if (!notes.length) return;
    stepIndex = Math.max(0, Math.min(notes.length - 1, stepIndex + delta));
    syncStepHighlight();
    const ev = notes[stepIndex]!;
    if (play) {
      await withPlayback(async () => {
        const ctx = await tracker.ensureContext();
        await playFreq(ctx, westernNoteToHz(swaraToWesternNote(ev.swara, ev.octave, saHz)), 380);
      });
    }
  }

  function buildExport(title: string | undefined, date: Date): string {
    return formatNotationText({
      title,
      date,
      saNote: hzToWesternNote(saHz).note,
      saHz,
      level: skillLevel,
      swaraLine: formatNotationLine(collector.getEvents(), saHz, 'swara'),
      keyboardLine: formatKeyboardAscii(collector.getEvents(), saHz),
    });
  }

  function onDownload(): void {
    const date = new Date();
    const title = els.titleInput.value;
    const text = buildExport(title, date);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = notationFilename(title, date);
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    els.status.textContent = 'Downloaded a text file of the notation.';
  }

  function onPrint(): void {
    const date = new Date();
    const title = els.titleInput.value.trim() || 'Swara Mirror notation';
    const text = buildExport(els.titleInput.value, date);
    els.printSheet.innerHTML = `<h1>${escapeHtml(title)}</h1><pre class="print-lines">${escapeHtml(text)}</pre>`;
    window.print();
  }

  fillSaDropdown();
  applyLevel(skillLevel, false);
  applyFormat('both');
  updateSaReadout();
  renderPitch(null, null);
  renderStrip();

  els.btnListen.addEventListener('click', () => void onListenClick());

  const resumeIfListening = () => {
    if (!listening) return;
    tracker.primeFromUserGesture();
    void tracker.resume();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeIfListening();
  });
  window.addEventListener('pageshow', resumeIfListening);
  window.addEventListener('focus', resumeIfListening);
  els.stage.addEventListener('touchstart', () => void tracker.resume(), { passive: true });

  els.btnSa.addEventListener('click', () => void startCalibration('mic'));
  els.btnCopy.addEventListener('click', () => void onCopy());
  els.btnClear.addEventListener('click', onClear);
  els.btnPlay.addEventListener('click', () => void onPlay());
  els.btnPrev.addEventListener('click', () => void stepBy(-1));
  els.btnNext.addEventListener('click', () => void stepBy(1));
  els.btnDownload.addEventListener('click', onDownload);
  els.btnPrint.addEventListener('click', onPrint);
  els.saSelect.addEventListener('change', () => {
    setSa(westernNoteToHz(els.saSelect.value), els.saSelect.value);
    els.status.textContent = `Sa set to ${els.saSelect.value}.`;
    void playSaReference(westernNoteToHz(els.saSelect.value));
  });
  root.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.level as SkillLevel;
      applyLevel(value);
      els.status.textContent = `Level set to ${settingsFor(value).label}.`;
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-forgiving]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const on = btn.dataset.forgiving === 'on';
      applyLevel(skillLevel, false, on);
      els.status.textContent = on
        ? 'Forgiving pitch is on — short slides are ignored and wobble is smoothed.'
        : 'Forgiving pitch is off.';
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-format]').forEach((btn) => {
    btn.addEventListener('click', () => applyFormat(btn.dataset.format as NotationFormat));
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
    startCalibration: (mode = 'silent') => startCalibration(mode),
    stopListening: () => stopListening(),
    setLevel: (next) => applyLevel(next),
    setForgiving: (on) => applyLevel(skillLevel, false, on),
    setFormat: (next) => applyFormat(next),
    getExportText: (title, date) => buildExport(title, date ?? new Date()),
    getState: () => ({
      listening,
      calibrating,
      saHz,
      saNote: hzToWesternNote(saHz).note,
      frequency: lastFreq,
      pitch: lastPitch,
      westernNote: lastPitch ? swaraToWesternNote(lastPitch.swara, lastPitch.octave, saHz) : hzToWesternNote(saHz).note,
      notationAscii: collector.toAsciiText(),
      notationGlyph: collector.toGlyphText(),
      keyboardLine: formatKeyboardAscii(collector.getEvents(), saHz),
      error: lastError,
      level: skillLevel,
      format,
      calProgress,
      saLocked,
      liveStatus,
      listenElapsedMs: listening ? Math.max(0, performance.now() - listenStarted) : 0,
      inputLevel,
      contextState: tracker.contextState,
      micLive: tracker.isMicLive(),
      wantsMic: tracker.wantsMic(),
      forgiving,
      whistle: register.isWhistle(),
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function layout(): string {
  return `
    <header class="header">
      <p class="tamil">ஸ்வர கண்ணாடி</p>
      <h1 class="english">Swara Mirror</h1>
      <p class="tagline">Tap once, then sing. Swaras appear as you hold a note.</p>
      <div class="gold-rule" aria-hidden="true"></div>
    </header>

    <section class="card swara-stage" aria-live="polite">
      <button id="btn-listen" class="primary sing-btn" type="button">Tap to sing</button>
      <div id="live-pill" class="live-pill" hidden><span class="dot"></span><span>Listening… sing now</span></div>
      <div id="cal-panel" class="cal-panel live-panel" hidden>
        <div class="level-meter" aria-hidden="true"><div id="level-fill" class="level-fill"></div></div>
        <p id="listen-timer" class="listen-timer">0:00</p>
        <p id="cal-hearing" class="cal-hearing">Listening… sing now</p>
        <div id="cal-progress" class="cal-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Sa detection progress">
          <div id="cal-progress-fill" class="cal-progress-fill"></div>
        </div>
      </div>
      <div class="pitch-pair">
        <p id="big-swara" class="big-swara">S</p>
        <p id="western-note" class="western-note">C#4</p>
      </div>
      <p id="swara-name" class="swara-name"></p>
      <p id="intonation" class="intonation"></p>
      <div class="cents-meter" aria-hidden="true">
        <div class="cents-track"></div>
        <div class="cents-center"></div>
        <div id="cents-needle" class="cents-needle" style="left: 50%"></div>
      </div>
      <div id="cents-label" class="cents-label">— cents</div>
      <div class="staff-wrap no-print">
        <canvas id="staff" width="720" height="220" aria-label="Scrolling swara line"></canvas>
      </div>
    </section>

    <section class="card">
      <p class="notation-label">Notation</p>
      <div class="format-toggle no-print" role="radiogroup" aria-label="Notation format">
        <button type="button" role="radio" data-format="swara">Swara</button>
        <button type="button" role="radio" data-format="keyboard">Keyboard notes</button>
        <button type="button" role="radio" data-format="both">Both</button>
      </div>
      <div id="notation-strip" class="notation-strip empty"></div>
      <div class="row no-print">
        <button id="btn-copy" type="button">Copy notation</button>
        <button id="btn-play" type="button">Play notation</button>
        <button id="btn-clear" type="button">Clear</button>
      </div>
      <div class="piano-wrap no-print">
        <p class="notation-label">Keyboard</p>
        <div id="piano"></div>
        <p id="whistle-hint" class="status" hidden>Hearing a whistle — showing it on the keyboard.</p>
        <p id="step-label" class="status">Play or step through the captured notation to see the next key.</p>
        <div class="row">
          <button id="btn-prev" type="button">Previous key</button>
          <button id="btn-next" type="button">Next key</button>
        </div>
      </div>
    </section>

    <details class="card settings-panel no-print">
      <summary>Settings</summary>
      <p class="notation-label">Skill level</p>
      <div class="level-toggle" role="radiogroup" aria-label="Skill level">
        <button type="button" role="radio" data-level="beginner">Beginner</button>
        <button type="button" role="radio" data-level="intermediate">Intermediate</button>
        <button type="button" role="radio" data-level="advanced">Advanced</button>
      </div>
      <p class="notation-label">Forgiving pitch</p>
      <div class="level-toggle" role="radiogroup" aria-label="Forgiving pitch">
        <button type="button" role="radio" data-forgiving="on">On</button>
        <button type="button" role="radio" data-forgiving="off">Off</button>
      </div>
      <p class="sa-readout">On by default for Beginner. Notes shorter than about a quarter second are ignored, and wobble is smoothed.</p>
      <p class="notation-label">Your Sa</p>
      <div class="sa-row">
        <label>
          <span class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Pick a Sa</span>
          <select id="sa-select" aria-label="Pick a Sa"></select>
        </label>
        <button id="btn-set-sa" type="button">Set my Sa</button>
      </div>
      <p id="sa-readout" class="sa-readout"></p>
      <p id="status" class="status"></p>
      <p id="error" class="error" role="alert"></p>
    </details>

    <section class="card no-print">
      <p class="notation-label">Save</p>
      <label>
        <span class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Song title</span>
        <input id="song-title" class="title-input" type="text" maxlength="80" placeholder="Optional song title" autocomplete="off" />
      </label>
      <div class="row">
        <button id="btn-download" type="button">Download .txt</button>
        <button id="btn-print" type="button">Print / PDF</button>
      </div>
    </section>

    <section id="print-sheet" class="print-sheet"></section>

    <p class="privacy no-print"><strong>Your voice stays on this device.</strong> Pitch is detected in the browser. Nothing is uploaded, and no AI service is used. Only your skill-level preference is remembered on this device.</p>
  `;
}

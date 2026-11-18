/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { westernNoteToHz } from '../music/swara';
import { mountApp, type SwaraMirrorApi } from './app';

class FakeParam {
  value = 0;
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
  setTargetAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode {
  connect(): FakeNode {
    return this;
  }
  disconnect(): void {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeOscillator extends FakeNode {
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  setPeriodicWave(): void {}
  start(): void {}
  stop(): void {}
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  getFloatTimeDomainData(out: Float32Array): void {
    out.fill(0);
  }
  getByteTimeDomainData(out: Uint8Array): void {
    out.fill(128);
  }
}

class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = 'running';
  destination = new FakeNode();
  sampleRate = 48000;
  createGain(): FakeGain {
    return new FakeGain();
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator();
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
  createPeriodicWave(): object {
    return {};
  }
  createMediaStreamSource(_stream: MediaStream): FakeNode {
    return new FakeNode();
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  addEventListener(): void {}
}

function stubCanvas(): void {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    const noop = () => {};
    return {
      clearRect: noop,
      save: noop,
      restore: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      rect: noop,
      clip: noop,
      stroke: noop,
      fill: noop,
      arc: noop,
      fillText: noop,
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return new DOMRect(0, 0, 720, 220);
  };
}

function stubMedia(tracks: MediaStreamTrack[]): void {
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => stream),
    },
  });
}

function liveTrack(): MediaStreamTrack {
  const track = {
    kind: 'audio',
    enabled: true,
    readyState: 'live' as MediaStreamTrackState,
    stop() {
      this.readyState = 'ended';
    },
    addEventListener(): void {},
  };
  return track as unknown as MediaStreamTrack;
}

async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

describe('setting Sa does not start Tap to sing', () => {
  let root: HTMLElement;
  let api: SwaraMirrorApi;
  let tracks: ReturnType<typeof liveTrack>[];

  beforeEach(() => {
    vi.useFakeTimers();
    stubCanvas();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('webkitAudioContext', FakeAudioContext);
    tracks = [liveTrack()];
    stubMedia(tracks);
    root = document.createElement('div');
    document.body.append(root);
    api = mountApp(root);
    api.setLevel('beginner');
  });

  afterEach(() => {
    api.stopListening();
    root.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('changing the Sa dropdown does not start the mic or listening', async () => {
    const select = root.querySelector<HTMLSelectElement>('#sa-select')!;
    select.value = 'A4';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(20);
    const state = api.getState();
    expect(state.listening).toBe(false);
    expect(state.calibrating).toBe(false);
    expect(state.wantsMic).toBe(false);
    expect(state.micLive).toBe(false);
    expect(state.saNote).toBe('A4');
    expect(root.querySelector('#btn-listen')!.textContent).toBe('Tap to sing');
    expect(tracks[0]!.readyState).toBe('live'); // never started, so never stopped either
    expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('Set my Sa borrows the mic, then stops it and does not leave Tap to sing on', async () => {
    const hz = westernNoteToHz('G4');
    const btn = root.querySelector<HTMLButtonElement>('#btn-set-sa')!;
    btn.click();
    await flush(30);
    expect(api.getState().listening).toBe(false);
    expect(api.getState().calibrating).toBe(true);
    expect(api.getState().wantsMic).toBe(true);
    expect(api.getState().micLive).toBe(true);
    expect(root.querySelector('#btn-listen')!.textContent).toBe('Tap to sing');

    api.injectHz(hz);
    await flush(800);

    const state = api.getState();
    expect(state.calibrating).toBe(false);
    expect(state.listening).toBe(false);
    expect(state.saLocked).toBe(true);
    expect(state.saNote).toBe('G4');
    expect(state.wantsMic).toBe(false);
    expect(state.micLive).toBe(false);
    expect(tracks[0]!.readyState).toBe('ended');
    expect(root.querySelector('#btn-listen')!.textContent).toBe('Tap to sing');
  });

  it('keeps listening after Set my Sa if the user already tapped Tap to sing', async () => {
    const listen = root.querySelector<HTMLButtonElement>('#btn-listen')!;
    listen.click();
    await flush(30);
    expect(api.getState().listening).toBe(true);
    expect(api.getState().micLive).toBe(true);

    const hz = westernNoteToHz('F4');
    root.querySelector<HTMLButtonElement>('#btn-set-sa')!.click();
    await flush(30);
    expect(api.getState().listening).toBe(true);
    expect(api.getState().calibrating).toBe(true);

    api.injectHz(hz);
    await flush(800);

    const state = api.getState();
    expect(state.calibrating).toBe(false);
    expect(state.listening).toBe(true);
    expect(state.saNote).toBe('F4');
    expect(state.wantsMic).toBe(true);
    expect(listen.textContent).toBe('Stop');
  });
});

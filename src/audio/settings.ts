/** Shared live/offline pipeline settings so the eval harness matches the app. */
export const AUDIO_SETTINGS = {
  fftSize: 4096,
  listenThreshold: 0.28,
  listenMinProbability: 0.42,
  listenMinRms: 0.0015,
  calibrateThreshold: 0.32,
  calibrateMinProbability: 0.38,
  calibrateMinRms: 0.003,
  minHz: 70,
  /** High enough for a bright whistle (~1–3 kHz) without losing low voices. */
  maxHz: 4000,
  inputGain: 2.4,
  makeupTargetRms: 0.15,
  makeupMaxGain: 20,
  octaveConfirmMs: 220,
  displayHoldMs: 80,
  notationHoldMs: 180,
  notationRestMs: 280,
  hysteresisCents: 18,
} as const;

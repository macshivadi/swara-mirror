import { describe, expect, it } from 'vitest';
import {
  saChangeStartsListening,
  saToneMustStopMic,
  shouldKeepMicAfterCalibration,
} from './micPolicy';

describe('mic policy around Sa changes', () => {
  it('never auto-starts Tap to sing when the user changes or sets Sa', () => {
    expect(saChangeStartsListening()).toBe(false);
  });

  it('stops the mic after calibration unless the user is already listening', () => {
    expect(shouldKeepMicAfterCalibration(false)).toBe(false);
    expect(shouldKeepMicAfterCalibration(true)).toBe(true);
  });

  it('requires a Sa reference tone to play with the mic stopped', () => {
    expect(saToneMustStopMic()).toBe(true);
  });
});

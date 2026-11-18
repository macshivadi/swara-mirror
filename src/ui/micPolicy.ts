/**
 * When the capture microphone is allowed to stay open.
 *
 * iOS ducks playback (play-and-record) while a live mic track exists, so
 * the mic must not start just because the user set Sa, and any temporary
 * use for calibration must be released afterward.
 */

/** Changing or confirming Sa in Settings must never start a listen session. */
export function saChangeStartsListening(): boolean {
  return false;
}

/**
 * After Set my Sa / calibration finishes (success or failure), keep the
 * mic only if the user is already in an explicit Tap to sing session.
 * A calibration that opened the mic itself must stop every capture track.
 */
export function shouldKeepMicAfterCalibration(listening: boolean): boolean {
  return listening;
}

/** A Sa reference tone must run with capture tracks stopped. */
export function saToneMustStopMic(): boolean {
  return true;
}

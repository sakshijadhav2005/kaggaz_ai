import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { Capacitor } from '@capacitor/core';

import { strings } from '../i18n';

/**
 * App lock: fingerprint/face, or the phone's PIN/pattern as a fallback. Settings live in localStorage,
 * not the database, because the lock decision is made before anything else loads.
 */

export interface LockSettings {
  enabled: boolean;
  /** How long the app may sit in the background before it locks again. 0 = immediately. */
  autoLockMs: number;
}

/** Labels are in src/i18n (lock.choices). */
export const AUTO_LOCK_CHOICES = [0, 30_000, 60_000, 300_000];

const STORE = 'kaagaz.lock';
const DEFAULTS: LockSettings = { enabled: false, autoLockMs: 30_000 };

export const lockSupported = () => Capacitor.isNativePlatform();

export function lockSettings(): LockSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<LockSettings> | null;
    return { ...DEFAULTS, ...saved, enabled: lockSupported() && !!saved?.enabled };
  } catch {
    return DEFAULTS;
  }
}

export function saveLockSettings(s: LockSettings) {
  localStorage.setItem(STORE, JSON.stringify(s));
}

export type LockProblem = 'androidOnly' | 'noScreenLock';

/** Why a lock cannot be used, or null if it can. */
export async function lockUnavailableReason(): Promise<LockProblem | null> {
  if (!lockSupported()) return 'androidOnly';
  const r = await BiometricAuth.checkBiometry();
  if (r.isAvailable || r.deviceIsSecure) return null;
  return 'noScreenLock';
}

/** Shows the system prompt. Resolves on success; rejects if the user cancels or fails. */
export async function authenticate(reason: string): Promise<void> {
  expectExternalActivity(); // the system prompt itself sends the app to the background
  await BiometricAuth.authenticate({
    reason,
    androidTitle: 'Kaagaz',
    androidSubtitle: reason,
    cancelTitle: strings().common.cancel,
    allowDeviceCredential: true,
  });
}

// The scanner, file picker, camera and the unlock prompt open other screens, which puts Kaagaz in the
// background. Those trips should not lock the app, so callers announce them first.
// An announcement only covers a trip that starts within a few seconds, so a stale one never excuses
// a later, real trip to the background.
let announcedAt = 0;
const ANNOUNCE_WINDOW_MS = 5_000;

/** Call just before opening the scanner, a file picker or the camera. */
export function expectExternalActivity() {
  announcedAt = Date.now();
}

/** Called by LockGate when the app goes to the background. True if a caller announced this trip. */
export function consumeExternalActivity(): boolean {
  const announced = Date.now() - announcedAt < ANNOUNCE_WINDOW_MS;
  announcedAt = 0;
  return announced;
}

import { Capacitor, registerPlugin } from '@capacitor/core';

/*
 * Play Integrity on the app side (android/.../IntegrityPlugin.java). Used only when the build sets
 * VITE_PLAY_CLOUD_PROJECT_NUMBER, which must match a proxy running with PLAY_INTEGRITY=required.
 */

interface IntegrityPluginApi {
  requestToken(o: { nonce: string; cloudProjectNumber: string }): Promise<{ token: string }>;
}

const Integrity = registerPlugin<IntegrityPluginApi>('Integrity');

const projectNumber = () => ((import.meta.env.VITE_PLAY_CLOUD_PROJECT_NUMBER as string | undefined) ?? '').trim();

/** True when registration must carry a Play Integrity token. */
export const integrityRequired = () => projectNumber() !== '';

/** A Play Integrity token bound to [nonce]. Android only. */
export async function integrityToken(nonce: string): Promise<string> {
  if (!Capacitor.isNativePlatform()) throw new Error('This build only works in the Android app from Google Play.');
  return (await Integrity.requestToken({ nonce, cloudProjectNumber: projectNumber() })).token;
}

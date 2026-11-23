/*
 * Consent for online AI (DPDP Act 2023). Nothing leaves the phone for the cloud unless the user has agreed
 * to the current notice. The check sits where requests leave the app (src/llm/gemini.ts), so no feature can
 * skip it. Without consent everything still works on the phone: rule sorting, word search and offline Gemma.
 *
 * Consent is tied to the notice version: change what is sent or to whom, bump CLOUD_NOTICE_VERSION, and the
 * user is asked again. Each grant and withdrawal is also written to the hash-chained audit log (db.ts).
 */

/** Bump when the notice text (src/i18n, consent.points) changes in substance, in any language. */
/** 2: audio recordings are sent for transcription. */
export const CLOUD_NOTICE_VERSION = 2;

/*
 * The notice text itself is in src/i18n (consent.*), in English and Hindi. The audit record keeps the version
 * and the language it was shown in.
 */

export type ConsentStatus = 'granted' | 'declined' | 'unasked';

interface Stored {
  granted: boolean;
  version: number;
  at: number;
}

const STORE = 'kaagaz.cloudConsent';

function read(): Stored | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Stored | null;
    return s && typeof s.granted === 'boolean' ? s : null;
  } catch {
    return null;
  }
}

/** Consent to an older notice counts as not asked: the user must see the new one. */
export function cloudConsent(): ConsentStatus {
  const s = read();
  if (!s || s.version !== CLOUD_NOTICE_VERSION) return 'unasked';
  return s.granted ? 'granted' : 'declined';
}

/** When the current answer was given, or null. */
export function cloudConsentDate(): Date | null {
  const s = read();
  return s && s.version === CLOUD_NOTICE_VERSION ? new Date(s.at) : null;
}

export type AuditSink = (event: string, details: Record<string, unknown>) => Promise<void>;

let audit: AuditSink | null = null;
const listeners = new Set<() => void>();

/** Set once at start-up (services.ts). */
export function setConsentAudit(sink: AuditSink) {
  audit = sink;
}

export function onConsentChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * Records the user's answer. The choice takes effect before the audit write, so a withdrawal stops
 * sending even if logging fails; a failed log is reported to the caller.
 */
export async function setCloudConsent(granted: boolean, via: 'first-run' | 'settings', lang: string = 'en'): Promise<void> {
  const at = Date.now();
  localStorage.setItem(STORE, JSON.stringify({ granted, version: CLOUD_NOTICE_VERSION, at } satisfies Stored));
  listeners.forEach((fn) => fn());
  await audit?.(granted ? 'consent.cloud.granted' : 'consent.cloud.withdrawn', {
    noticeVersion: CLOUD_NOTICE_VERSION,
    lang,
    via,
    at: new Date(at).toISOString(),
  });
}

/** Thrown where a request would leave the phone without consent. */
export class CloudConsentError extends Error {
  constructor() {
    super('Online AI is turned off. Turn it on in Settings to use it.');
  }
}

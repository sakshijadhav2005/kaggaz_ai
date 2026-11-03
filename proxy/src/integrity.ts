/*
 * Google Play Integrity for the proxy: only the genuine Kaagaz app, installed from Google Play on a real
 * Android device, can get a device token. Off unless PLAY_INTEGRITY=required.
 *
 *   POST /v1/challenge -> { nonce }   a signed, five-minute nonce (no server state)
 *   app: Play Integrity token for that nonce (IntegrityPlugin.java)
 *   POST /v1/register { nonce, integrityToken } -> { token }   only if Google's verdict passes
 */

export interface IntegrityEnv {
  PLAY_INTEGRITY?: string;
  PLAY_PACKAGE_NAME?: string;
  /** The JSON key of a Google Cloud service account allowed to call the Play Integrity API. Secret. */
  GOOGLE_SERVICE_ACCOUNT?: string;
}

export class IntegrityError extends Error {}

const NONCE_TTL_MS = 5 * 60_000;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', enc.encode(`nonce|${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/**
 * random (16) | issued-at ms (8) | HMAC of both (32), base64url: the character set Play Integrity requires.
 * The HMAC key is derived from TOKEN_SECRET, so no extra secret is needed.
 */
export async function makeNonce(secret: string, now = Date.now()): Promise<string> {
  const body = new Uint8Array(24);
  body.set(crypto.getRandomValues(new Uint8Array(16)), 0);
  new DataView(body.buffer).setBigUint64(16, BigInt(now));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), body));
  const out = new Uint8Array(56);
  out.set(body, 0);
  out.set(mac, 24);
  return b64url(out);
}

export async function checkNonce(secret: string, nonce: string, now = Date.now()): Promise<void> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromB64url(nonce);
  } catch {
    throw new IntegrityError('Bad challenge.');
  }
  if (raw.length !== 56) throw new IntegrityError('Bad challenge.');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), raw.slice(24), raw.slice(0, 24));
  if (!ok) throw new IntegrityError('Bad challenge.');
  const issued = Number(new DataView(raw.buffer).getBigUint64(16));
  if (now - issued > NONCE_TTL_MS || issued - now > 60_000) throw new IntegrityError('The challenge has expired. Try again.');
}

// Google service-account OAuth (RS256 JWT bearer), cached for the life of the isolate.

let cached: { token: string; until: number; email: string } | null = null;

function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function googleAccessToken(serviceAccountJson: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const sa = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string; token_uri?: string };
  if (cached && cached.email === sa.client_email && cached.until > now + 60_000) return cached.token;
  const iat = Math.floor(now / 1000);
  const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/playintegrity', aud, iat, exp: iat + 3600 })));
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`)));
  const res = await fetcher(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${await res.text()}`);
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: access_token, until: now + expires_in * 1000, email: sa.client_email };
  return access_token;
}

/** For tests. */
export const resetTokenCache = () => {
  cached = null;
};

interface Verdict {
  requestDetails?: { requestPackageName?: string; nonce?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
}

/**
 * Has Google decode the token, then checks: our package, our nonce, recent, the app as published on
 * Play, on a device that passes Android's integrity checks. Throws IntegrityError when any fails.
 */
export async function verifyIntegrity(env: IntegrityEnv, nonce: string, integrityToken: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const pkg = env.PLAY_PACKAGE_NAME;
  if (!pkg || !env.GOOGLE_SERVICE_ACCOUNT) throw new Error('Play Integrity is required but not configured.');
  const access = await googleAccessToken(env.GOOGLE_SERVICE_ACCOUNT, fetcher, now);
  const res = await fetcher(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(pkg)}:decodeIntegrityToken`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ integrity_token: integrityToken }),
  });
  if (res.status === 400) throw new IntegrityError('This app could not be verified.');
  if (!res.ok) throw new Error(`Play Integrity ${res.status}: ${await res.text()}`);
  const v = ((await res.json()) as { tokenPayloadExternal?: Verdict }).tokenPayloadExternal ?? {};

  const rd = v.requestDetails ?? {};
  const fail = (why: string) => {
    throw new IntegrityError(`This app could not be verified (${why}). Install Kaagaz from Google Play.`);
  };
  if (rd.requestPackageName !== pkg) fail('package');
  if (rd.nonce !== nonce) fail('challenge');
  if (Math.abs(now - Number(rd.timestampMillis ?? 0)) > NONCE_TTL_MS) fail('time');
  if (v.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') fail('app');
  if (!v.deviceIntegrity?.deviceRecognitionVerdict?.includes('MEETS_DEVICE_INTEGRITY')) fail('device');
}

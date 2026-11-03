import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../proxy/src/index';
import { checkNonce, googleAccessToken, makeNonce, resetTokenCache, verifyIntegrity } from '../proxy/src/integrity';

const SECRET = 'token-secret';
const PKG = 'app.kaagaz';

/** A real RSA key, so the JWT the proxy signs can be checked like Google would. */
const keys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
const SERVICE_ACCOUNT = JSON.stringify({ client_email: 'kaagaz@proj.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n` });

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** What the fake Google decodes the next token into. */
let verdict: Record<string, unknown>;
let oauthCalls: number;

const goodVerdict = (nonce: string, now = Date.now()) => ({
  requestDetails: { requestPackageName: PKG, nonce, timestampMillis: String(now) },
  appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED' },
  deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
});

/** Google's OAuth and Play Integrity endpoints. */
const google: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === 'https://oauth2.googleapis.com/token') {
    oauthCalls++;
    const assertion = new URLSearchParams(String(init?.body)).get('assertion')!;
    const [h, c, sig] = assertion.split('.');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, fromB64url(sig), new TextEncoder().encode(`${h}.${c}`));
    const claims = JSON.parse(fromB64url(c).toString());
    if (!ok || claims.scope !== 'https://www.googleapis.com/auth/playintegrity') return new Response('bad jwt', { status: 401 });
    return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
  }
  if (url === `https://playintegrity.googleapis.com/v1/${PKG}:decodeIntegrityToken`) {
    if (new Headers(init?.headers).get('authorization') !== 'Bearer ya29.test') return new Response('no auth', { status: 401 });
    const { integrity_token } = JSON.parse(String(init?.body));
    if (integrity_token === 'garbage') return new Response('bad token', { status: 400 });
    return Response.json({ tokenPayloadExternal: verdict });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const env = (over: Partial<Env> = {}): Env => ({
  GEMINI_API_KEY: 'k',
  TOKEN_SECRET: SECRET,
  PLAY_INTEGRITY: 'required',
  PLAY_PACKAGE_NAME: PKG,
  GOOGLE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
  ...over,
});

const post = (e: Env, path: string, body?: unknown) =>
  worker.fetch(new Request(`https://proxy.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), e);

beforeEach(() => {
  resetTokenCache();
  oauthCalls = 0;
  vi.stubGlobal('fetch', google);
});
afterEach(() => vi.unstubAllGlobals());

describe('challenge nonces', () => {
  it('accepts its own fresh nonce, in the alphabet Play Integrity requires', async () => {
    const n = await makeNonce(SECRET);
    expect(n).toMatch(/^[A-Za-z0-9_-]{16,500}$/);
    await expect(checkNonce(SECRET, n)).resolves.toBeUndefined();
  });

  it('rejects forged, altered and expired nonces', async () => {
    const n = await makeNonce(SECRET);
    await expect(checkNonce('other-secret', n)).rejects.toThrow(/Bad challenge/);
    const flipped = n.slice(0, 10) + (n[10] === 'A' ? 'B' : 'A') + n.slice(11);
    await expect(checkNonce(SECRET, flipped)).rejects.toThrow(/Bad challenge/);
    await expect(checkNonce(SECRET, 'short')).rejects.toThrow(/Bad challenge/);
    const old = await makeNonce(SECRET, Date.now() - 6 * 60_000);
    await expect(checkNonce(SECRET, old)).rejects.toThrow(/expired/);
  });
});

describe('Google verdict', () => {
  it('signs a valid service-account JWT and caches the access token', async () => {
    expect(await googleAccessToken(SERVICE_ACCOUNT, google)).toBe('ya29.test');
    await googleAccessToken(SERVICE_ACCOUNT, google);
    expect(oauthCalls).toBe(1);
  });

  it('passes the genuine app on a real device', async () => {
    const n = await makeNonce(SECRET);
    verdict = goodVerdict(n);
    await expect(verifyIntegrity(env(), n, 'tok', google)).resolves.toBeUndefined();
  });

  it.each([
    ['package', (v: any) => (v.requestDetails.requestPackageName = 'com.fake.kaagaz')],
    ['challenge', (v: any) => (v.requestDetails.nonce = 'someone-elses-nonce')],
    ['time', (v: any) => (v.requestDetails.timestampMillis = String(Date.now() - 10 * 60_000))],
    ['app', (v: any) => (v.appIntegrity.appRecognitionVerdict = 'UNRECOGNIZED_VERSION')],
    ['device', (v: any) => (v.deviceIntegrity.deviceRecognitionVerdict = [])],
  ])('fails on a bad %s', async (why, spoil) => {
    const n = await makeNonce(SECRET);
    verdict = goodVerdict(n);
    spoil(verdict);
    await expect(verifyIntegrity(env(), n, 'tok', google)).rejects.toThrow(new RegExp(`\\(${why}\\)`));
  });

  it('fails on a token Google cannot decode', async () => {
    await expect(verifyIntegrity(env(), await makeNonce(SECRET), 'garbage', google)).rejects.toThrow(/could not be verified/);
  });
});

describe('proxy with Play Integrity', () => {
  it('registers only after a challenge and a passing verdict', async () => {
    const e = env();
    expect((await post(e, '/v1/register')).status).toBe(403); // no token at all

    const { nonce } = (await (await post(e, '/v1/challenge')).json()) as { nonce: string };
    verdict = goodVerdict(nonce);
    const ok = await post(e, '/v1/register', { nonce, integrityToken: 'tok' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { token: string }).token).toMatch(/^v1\./);

    verdict = { ...goodVerdict(nonce), appIntegrity: { appRecognitionVerdict: 'UNEVALUATED' } };
    const bad = await post(e, '/v1/register', { nonce, integrityToken: 'tok' });
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain('Install Kaagaz from Google Play');
  });

  it('rejects a verdict for a different challenge than the one sent', async () => {
    const e = env();
    const { nonce } = (await (await post(e, '/v1/challenge')).json()) as { nonce: string };
    const other = await makeNonce(SECRET);
    verdict = goodVerdict(other); // token minted for another nonce, replayed with this one
    expect((await post(e, '/v1/register', { nonce, integrityToken: 'tok' })).status).toBe(403);
  });

  it('is off by default: no challenge endpoint, plain registration', async () => {
    const e = env({ PLAY_INTEGRITY: undefined });
    expect((await post(e, '/v1/challenge')).status).toBe(404);
    expect((await post(e, '/v1/register')).status).toBe(200);
  });
});

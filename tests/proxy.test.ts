import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { type Env, type RateLimiter } from '../proxy/src/index';
import { CLOUD_NOTICE_VERSION } from '../src/core/consent';
import { memoryStorage } from './helpers';


const GOOGLE = 'https://generativelanguage.googleapis.com/';
const PROXY = 'https://proxy.test';

const allow: RateLimiter = { limit: async () => ({ success: true }) };
const deny: RateLimiter = { limit: async () => ({ success: false }) };

const baseEnv = (over: Partial<Env> = {}): Env => ({
  GEMINI_API_KEY: 'server-secret-key',
  TOKEN_SECRET: 'token-secret',
  REGISTER_LIMITER: allow,
  GENERATE_LIMITER: allow,
  EMBED_LIMITER: allow,
  ...over,
});

/** What the fake Google saw. */
let upstream: { url: string; headers: Headers; body: any }[];
let googleReply: () => Response;

const googleOk = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: ' Answer ' }] } }], embedding: { values: [0.1, 0.2] } }), { status: 200 });

beforeEach(() => {
  upstream = [];
  googleReply = googleOk;
  vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.startsWith(GOOGLE)) {
      upstream.push({ url: req.url, headers: req.headers, body: await req.json() });
      return googleReply();
    }
    throw new Error(`unexpected fetch ${req.url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const call = (env: Env, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${PROXY}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env);

async function register(env: Env): Promise<string> {
  const res = await call(env, '/v1/register');
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('proxy worker', () => {
  it('registers, then generates with the server key and a fixed model', async () => {
    const env = baseEnv();
    const token = await register(env);
    const res = await call(env, '/v1/generate', { parts: [{ text: 'hi' }] }, auth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Answer' });
    expect(upstream[0].url).toContain('/gemma-4-31b-it:generateContent');
    expect(upstream[0].headers.get('x-goog-api-key')).toBe('server-secret-key');
  });

  it('embeds', async () => {
    const env = baseEnv();
    const res = await call(env, '/v1/embed', { text: 'chunk' }, auth(await register(env)));
    expect(await res.json()).toEqual({ values: [0.1, 0.2] });
    expect(upstream[0].url).toContain('/gemini-embedding-001:embedContent');
  });

  it('rejects missing, forged and re-signed tokens', async () => {
    const env = baseEnv();
    const token = await register(env);
    expect((await call(env, '/v1/generate', { parts: [{ text: 'x' }] })).status).toBe(401);
    expect((await call(env, '/v1/generate', { parts: [{ text: 'x' }] }, auth('v1.abc.def'))).status).toBe(401);
    const [v, , sig] = token.split('.');
    expect((await call(env, '/v1/generate', { parts: [{ text: 'x' }] }, auth(`${v}.otherDevice.${sig}`))).status).toBe(401);
    // A token from before a secret rotation stops working.
    expect((await call(baseEnv({ TOKEN_SECRET: 'rotated' }), '/v1/generate', { parts: [{ text: 'x' }] }, auth(token))).status).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  it('forwards only text and one image, nothing else from the client', async () => {
    const env = baseEnv();
    const t = await register(env);
    const img = { inline_data: { mime_type: 'image/png', data: 'AAAA' } };
    await call(env, '/v1/generate', { parts: [img, { text: 'read this', extra: 1 }], tools: [{ evil: true }], model: 'gemini-ultra' }, auth(t));
    expect(upstream[0].body).toEqual({ contents: [{ parts: [img, { text: 'read this' }] }], generationConfig: { temperature: 0 } });
    expect(upstream[0].url).not.toContain('ultra');

    expect((await call(env, '/v1/generate', { parts: [img, img] }, auth(t))).status).toBe(400);
    expect((await call(env, '/v1/generate', { parts: [{ inline_data: { mime_type: 'application/pdf', data: 'x' } }] }, auth(t))).status).toBe(400);
    expect((await call(env, '/v1/generate', { parts: [] }, auth(t))).status).toBe(400);
    expect((await call(env, '/v1/generate', { parts: [{ text: 'x'.repeat(200_001) }] }, auth(t))).status).toBe(413);
    expect((await call(env, '/v1/embed', { text: '' }, auth(t))).status).toBe(400);
  });

  it('rate limits registration and calls', async () => {
    expect((await call(baseEnv({ REGISTER_LIMITER: deny }), '/v1/register')).status).toBe(429);
    const env = baseEnv({ GENERATE_LIMITER: deny });
    const t = await register(env);
    expect((await call(env, '/v1/generate', { parts: [{ text: 'x' }] }, auth(t))).status).toBe(429);
    expect(upstream).toHaveLength(0);
  });

  it('maps upstream errors without leaking their details', async () => {
    const env = baseEnv();
    const t = await register(env);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    googleReply = () => new Response('API key AIza-secret invalid', { status: 400 });
    const res = await call(env, '/v1/generate', { parts: [{ text: 'x' }] }, auth(t));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('AIza');
    googleReply = () => new Response('slow down', { status: 429 });
    expect((await call(env, '/v1/generate', { parts: [{ text: 'x' }] }, auth(t))).status).toBe(429);
  });

  it('allows CORS only for the app origins', async () => {
    const env = baseEnv();
    const pre = (origin: string) => worker.fetch(new Request(`${PROXY}/v1/generate`, { method: 'OPTIONS', headers: { origin } }), env);
    expect((await pre('https://localhost')).headers.get('access-control-allow-origin')).toBe('https://localhost');
    expect((await pre('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses when not configured and on other methods', async () => {
    expect((await call(baseEnv({ GEMINI_API_KEY: '' }), '/v1/register')).status).toBe(500);
    expect((await worker.fetch(new Request(`${PROXY}/v1/register`), baseEnv())).status).toBe(405);
  });
});

describe('app client through the proxy', () => {
  /** Routes the app's fetches for PROXY into the worker, and records what the app sent. */
  function wire(env: { current: Env }) {
    const sent: Request[] = [];
    const google = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      if (!req.url.startsWith(PROXY)) return google(input, init);
      sent.push(req.clone());
      return worker.fetch(req, env.current);
    });
    return sent;
  }

  async function client(consent = true) {
    vi.stubGlobal('localStorage', memoryStorage());
    if (consent) localStorage.setItem('kaagaz.cloudConsent', JSON.stringify({ granted: true, version: CLOUD_NOTICE_VERSION, at: 1 }));
    vi.stubEnv('VITE_PROXY_URL', PROXY);
    vi.resetModules();
    return import('../src/llm/gemini');
  }

  it('registers once, never sends a Gemini key, and works for answers and embeddings', async () => {
    const env = { current: baseEnv() };
    const sent = wire(env);
    const g = await client();
    expect(g.usesProxy()).toBe(true);
    expect(g.hostedConfigured()).toBe(true);
    expect(g.getDevApiKey()).toBe('');

    expect(await new g.GemmaLlmClient().complete('hello')).toBe('Answer');
    expect(await new g.GemmaLlmClient().completeWithImage('read', 'AAAA', 'image/jpeg')).toBe('Answer');
    expect(await new g.GeminiEmbeddingProvider().embed('chunk')).toEqual([0.1, 0.2]);

    expect(sent.filter((r) => r.url.endsWith('/v1/register'))).toHaveLength(1);
    for (const r of sent) {
      expect(r.headers.get('x-goog-api-key')).toBeNull();
      expect(await r.text()).not.toContain('server-secret-key');
    }
  });

  it('gets a new token by itself after the server secret is rotated', async () => {
    const env = { current: baseEnv() };
    const sent = wire(env);
    const g = await client();
    const llm = new g.GemmaLlmClient();
    await llm.complete('one');
    env.current = baseEnv({ TOKEN_SECRET: 'rotated' });
    expect(await llm.complete('two')).toBe('Answer');
    expect(sent.filter((r) => r.url.endsWith('/v1/register'))).toHaveLength(2);
  });

  it('sends nothing at all without consent', async () => {
    const env = { current: baseEnv() };
    const sent = wire(env);
    const g = await client(false);
    expect(g.hostedConfigured()).toBe(true);
    expect(g.hostedAllowed()).toBe(false);
    await expect(new g.GemmaLlmClient().complete('hello')).rejects.toThrow(/Online AI is turned off/);
    await expect(new g.GeminiEmbeddingProvider().embed('document text')).rejects.toThrow(/turned off/);
    expect(sent).toHaveLength(0);
    expect(upstream).toHaveLength(0);
  });

  it('stops sending the moment consent is withdrawn', async () => {
    const env = { current: baseEnv() };
    const sent = wire(env);
    const g = await client();
    const consent = await import('../src/core/consent');
    await new g.GemmaLlmClient().complete('one');
    const before = sent.length;
    await consent.setCloudConsent(false, 'settings');
    await expect(new g.GemmaLlmClient().complete('two')).rejects.toThrow(/turned off/);
    expect(sent).toHaveLength(before);
  });

  it('surfaces server errors so the router can fall back to on-device Gemma', async () => {
    const env = { current: baseEnv({ GENERATE_LIMITER: deny }) };
    wire(env);
    const g = await client();
    await expect(new g.GemmaLlmClient().complete('x')).rejects.toThrow(/Kaagaz server 429/);
  });
});

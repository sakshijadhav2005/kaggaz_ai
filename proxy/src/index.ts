/**
 * Kaagaz proxy: the only place the Gemini API key lives. The app sends prompts here; this Worker adds
 * the key, picks the model and forwards the call to Google.
 *
 *   POST /v1/challenge -> { nonce }            only with PLAY_INTEGRITY=required (see integrity.ts)
 *   POST /v1/register  -> { token }            new install; rate limited per IP; with Play Integrity,
 *                                              body { nonce, integrityToken } and Google must vouch for the app
 *   POST /v1/generate  { parts } -> { text }   Gemma 4 (text, or one image + text)
 *   POST /v1/embed     { text } -> { values }  Gemini embedding
 *   POST /v1/transcribe { audio } -> { text }  speech to text for imported audio files (TRANSCRIBE_MODEL;
 *                                              the hosted Gemma 4 31B takes no audio)
 *
 * Tokens are "v1.<deviceId>.<hmac>", signed with TOKEN_SECRET, so no database is needed.
 * Rotating TOKEN_SECRET revokes every token; the app re-registers by itself.
 *
 * Tokens are anonymous, so anyone can get one. What stops abuse is that a token can only make the four
 * calls above, at a limited rate, with a fixed model and size limits. Set a quota on the Google key too.
 */

import { checkNonce, IntegrityError, makeNonce, verifyIntegrity, type IntegrityEnv } from './integrity';

export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface Env extends IntegrityEnv {
  GEMINI_API_KEY: string;
  TOKEN_SECRET: string;
  LLM_MODEL?: string;
  EMBED_MODEL?: string;
  /** Must accept audio input. */
  TRANSCRIBE_MODEL?: string;
  /** Comma-separated. The Android app's WebView origin is https://localhost. */
  ALLOWED_ORIGINS?: string;
  REGISTER_LIMITER?: RateLimiter;
  GENERATE_LIMITER?: RateLimiter;
  EMBED_LIMITER?: RateLimiter;
  TRANSCRIBE_LIMITER?: RateLimiter;
}

const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_ORIGINS = 'https://localhost,http://localhost:5173';
/** OCR sends one page image as base64; 12 MB covers a phone photo with room to spare. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_EMBED_CHARS = 20_000;
const MAX_PARTS = 4;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
/** The audio types the app imports (src/models.ts). */
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac', 'audio/ogg']);
/** Base64 of an 8 MB recording; the body cap above leaves room for the JSON around it. */
export const MAX_AUDIO_B64_CHARS = Math.ceil((8 * 1024 * 1024) / 3) * 4;
export const DEFAULT_TRANSCRIBE_MODEL = 'gemini-2.5-flash';
const TRANSCRIBE_PROMPT =
  'Transcribe this recording exactly as spoken, in the language spoken (Hindi in Devanagari). Do not translate or summarise. ' +
  'If there is no speech, reply [no speech]. Return only the transcription.';

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
      if (!env.GEMINI_API_KEY || !env.TOKEN_SECRET) throw new HttpError(500, 'Server is not configured.');
      const path = new URL(req.url).pathname;

      const integrity = env.PLAY_INTEGRITY === 'required';

      if (path === '/v1/challenge') {
        if (!integrity) throw new HttpError(404, 'Not found.');
        await limit(env.REGISTER_LIMITER, req.headers.get('cf-connecting-ip') ?? 'unknown');
        return json({ nonce: await makeNonce(env.TOKEN_SECRET) }, 200, cors);
      }

      if (path === '/v1/register') {
        await limit(env.REGISTER_LIMITER, req.headers.get('cf-connecting-ip') ?? 'unknown');
        if (integrity) {
          // No body, or not JSON, is simply an unverified app.
          const { nonce, integrityToken } = ((await readJson(req).catch(() => null)) ?? {}) as { nonce?: unknown; integrityToken?: unknown };
          if (typeof nonce !== 'string' || typeof integrityToken !== 'string') throw new HttpError(403, 'This app could not be verified. Install Kaagaz from Google Play.');
          try {
            await checkNonce(env.TOKEN_SECRET, nonce);
            await verifyIntegrity(env, nonce, integrityToken);
          } catch (e) {
            if (e instanceof IntegrityError) throw new HttpError(403, e.message);
            throw e;
          }
        }
        return json({ token: await issueToken(env.TOKEN_SECRET) }, 200, cors);
      }

      const deviceId = await verifyToken(env.TOKEN_SECRET, req.headers.get('authorization'));
      const body = await readJson(req);

      if (path === '/v1/generate') {
        await limit(env.GENERATE_LIMITER, deviceId);
        return json({ text: await generate(env, validateParts(body)) }, 200, cors);
      }
      if (path === '/v1/transcribe') {
        await limit(env.TRANSCRIBE_LIMITER, deviceId);
        return json({ text: await transcribe(env, validateAudio(body)) }, 200, cors);
      }
      if (path === '/v1/embed') {
        await limit(env.EMBED_LIMITER, deviceId);
        return json({ values: await embed(env, validateEmbedText(body)) }, 200, cors);
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      // Never echo internal errors; they can contain upstream details.
      console.error('proxy error', e);
      return json({ error: 'Server error.' }, 500, cors);
    }
  },
};

// Tokens

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
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function issueToken(secret: string): Promise<string> {
  const deviceId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`v1.${deviceId}`)));
  return `v1.${deviceId}.${b64url(sig)}`;
}

/** Returns the device id. crypto.subtle.verify compares in constant time. */
export async function verifyToken(secret: string, header: string | null): Promise<string> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const [v, deviceId, sig] = token.split('.');
  if (v !== 'v1' || !deviceId || !sig) throw new HttpError(401, 'Missing or bad token.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc.encode(`v1.${deviceId}`));
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, 'Missing or bad token.');
  return deviceId;
}

// Requests

async function limit(limiter: RateLimiter | undefined, key: string) {
  if (limiter && !(await limiter.limit({ key })).success) throw new HttpError(429, 'Too many requests. Try again in a minute.');
}

async function readJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

/** Only plain text and at most one image. Nothing else from the client reaches Google. */
export function validateParts(body: unknown): Part[] {
  const parts = (body as { parts?: unknown })?.parts;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) throw new HttpError(400, 'Bad parts.');
  let images = 0;
  let chars = 0;
  return parts.map((p): Part => {
    if (typeof p?.text === 'string') {
      chars += p.text.length;
      if (chars > MAX_TEXT_CHARS) throw new HttpError(413, 'Prompt too long.');
      return { text: p.text };
    }
    const img = p?.inline_data;
    if (img && IMAGE_TYPES.has(img.mime_type) && typeof img.data === 'string' && ++images <= 1) {
      return { inline_data: { mime_type: img.mime_type, data: img.data } };
    }
    throw new HttpError(400, 'Bad part.');
  });
}

type Audio = { mime_type: string; data: string };

/** One recording of a known type and size. The prompt is fixed here, so the route can only transcribe. */
export function validateAudio(body: unknown): Audio {
  const a = (body as { audio?: unknown })?.audio as Partial<Audio> | undefined;
  if (!a || typeof a.mime_type !== 'string' || !AUDIO_TYPES.has(a.mime_type) || typeof a.data !== 'string' || a.data.length === 0) {
    throw new HttpError(400, 'Bad audio.');
  }
  if (a.data.length > MAX_AUDIO_B64_CHARS) throw new HttpError(413, 'Recording too large.');
  return { mime_type: a.mime_type, data: a.data };
}

export function validateEmbedText(body: unknown): string {
  const text = (body as { text?: unknown })?.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_EMBED_CHARS) throw new HttpError(400, 'Bad text.');
  return text;
}

// Google

async function google(env: Env, model: string, method: string, body: unknown): Promise<any> {
  const res = await fetch(`${GOOGLE}/${model}:${method}`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new HttpError(429, 'The AI service is busy. Try again shortly.');
  if (!res.ok) {
    console.error('upstream', res.status, await res.text());
    throw new HttpError(502, `The AI service returned an error (${res.status}).`);
  }
  return res.json();
}

async function generate(env: Env, parts: Part[]): Promise<string> {
  const out = await google(env, env.LLM_MODEL || 'gemma-4-31b-it', 'generateContent', {
    contents: [{ parts }],
    generationConfig: { temperature: 0 },
  });
  const got: any[] = out.candidates?.[0]?.content?.parts ?? [];
  // Skip reasoning ("thought") parts; only the final answer is returned.
  return got.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
}

async function transcribe(env: Env, audio: Audio): Promise<string> {
  const out = await google(env, env.TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL, 'generateContent', {
    contents: [{ parts: [{ inline_data: audio }, { text: TRANSCRIBE_PROMPT }] }],
    generationConfig: { temperature: 0 },
  });
  const got: any[] = out.candidates?.[0]?.content?.parts ?? [];
  return got.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
}

async function embed(env: Env, text: string): Promise<number[]> {
  const model = env.EMBED_MODEL || 'gemini-embedding-001';
  const out = await google(env, model, 'embedContent', { model: `models/${model}`, content: { parts: [{ text }] } });
  return out.embedding.values as number[];
}

// Responses

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim());
  const origin = req.headers.get('origin') ?? '';
  const h: Record<string, string> = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (allowed.includes(origin)) h['access-control-allow-origin'] = origin;
  return h;
}

const json = (data: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, 'content-type': 'application/json' } });

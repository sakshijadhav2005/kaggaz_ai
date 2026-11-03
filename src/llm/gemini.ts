import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

import { CloudConsentError, cloudConsent } from '../core/consent';
import type { EmbeddingProvider, LlmClient } from '../interfaces';
import { integrityRequired, integrityToken } from './integrity';

/*
 * Hosted Gemma 4 and Gemini embeddings. This is the only file that talks to a server.
 *
 * Release builds set VITE_PROXY_URL: calls go to the Kaagaz proxy (proxy/), which holds the Gemini key.
 * The app only has an anonymous per-install token, created on first use and kept in secure storage.
 *
 * Without VITE_PROXY_URL (development), calls go straight to Google with a key from Settings or
 * VITE_GEMINI_API_KEY. Never ship that: the key would be readable by anyone with the app.
 */

const proxyUrl = () => ((import.meta.env.VITE_PROXY_URL as string | undefined) ?? '').replace(/\/+$/, '');

/** True when online calls go through the Kaagaz server (no key on the device). */
export const usesProxy = () => proxyUrl() !== '';

/** True when hosted Gemma is set up in this build (connection and consent aside). */
export const hostedConfigured = () => usesProxy() || getDevApiKey() !== '';

/** True when hosted Gemma is set up and the user has agreed to online AI. */
export const hostedAllowed = () => hostedConfigured() && cloudConsent() === 'granted';

/** The last line of defence: every request that leaves the phone passes through here first. */
function assertConsent() {
  if (cloudConsent() !== 'granted') throw new CloudConsentError();
}

// Proxy mode

const TOKEN_KEY = 'kaagaz_proxy_token';
let token: Promise<string> | null = null;

function getToken(): Promise<string> {
  assertConsent();
  token ??= (async () => {
    try {
      const { value } = await SecureStoragePlugin.get({ key: TOKEN_KEY });
      if (value) return value;
    } catch {
      // Not stored yet.
    }
    const res = await fetch(`${proxyUrl()}/v1/register`, { method: 'POST', signal: AbortSignal.timeout(15_000), ...(await integrityBody()) });
    if (!res.ok) throw new Error(await serverError(res));
    const { token: fresh } = (await res.json()) as { token: string };
    try {
      await SecureStoragePlugin.set({ key: TOKEN_KEY, value: fresh });
    } catch {
      // Kept in memory for this session; registers again next launch.
    }
    return fresh;
  })().catch((e: unknown) => {
    token = null; // let the next call try again
    throw e;
  });
  return token;
}

/** With Play Integrity on: a server challenge, answered by Google Play on this phone. */
async function integrityBody(): Promise<RequestInit> {
  if (!integrityRequired()) return {};
  const res = await fetch(`${proxyUrl()}/v1/challenge`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(await serverError(res));
  const { nonce } = (await res.json()) as { nonce: string };
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, integrityToken: await integrityToken(nonce) }),
  };
}

async function forgetToken() {
  token = null;
  try {
    await SecureStoragePlugin.remove({ key: TOKEN_KEY });
  } catch {
    // Nothing stored.
  }
}

async function serverError(res: Response): Promise<string> {
  let detail = '';
  try {
    detail = ((await res.json()) as { error?: string }).error ?? '';
  } catch {
    // Not JSON.
  }
  return `Kaagaz server ${res.status}${detail ? `: ${detail}` : ''}`;
}

async function proxyPost<T>(path: string, body: unknown, retry = true): Promise<T> {
  assertConsent();
  const res = await fetch(`${proxyUrl()}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await getToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  // The server's signing secret was rotated: get a new token once.
  if (res.status === 401 && retry) {
    await forgetToken();
    return proxyPost(path, body, false);
  }
  if (!res.ok) throw new Error(await serverError(res));
  return res.json() as Promise<T>;
}

// Direct mode (development only)

const KEY_STORE = 'kaagaz_api_key';
const envKey = () => (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) || '';

export const getDevApiKey = (): string => {
  if (usesProxy()) return '';
  try {
    return localStorage.getItem(KEY_STORE) || envKey();
  } catch {
    return envKey();
  }
};

export const setDevApiKey = (key: string) => localStorage.setItem(KEY_STORE, key.trim());

const LLM_MODEL = (import.meta.env.VITE_LLM_MODEL as string | undefined) || 'gemma-4-31b-it';
const EMBED_MODEL = (import.meta.env.VITE_EMBED_MODEL as string | undefined) || 'gemini-embedding-001';
const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function googlePost(model: string, method: string, body: unknown): Promise<any> {
  assertConsent();
  const key = getDevApiKey();
  if (!key) throw new Error('No API key. Add one in Settings.');
  const res = await fetch(`${GOOGLE}/${model}:${method}`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Clients

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

export class GemmaLlmClient implements LlmClient {
  complete(prompt: string) {
    return this.generate([{ text: prompt }]);
  }

  completeWithImage(prompt: string, base64: string, mimeType: string) {
    return this.generate([{ inline_data: { mime_type: mimeType, data: base64 } }, { text: prompt }]);
  }

  private async generate(parts: Part[]): Promise<string> {
    if (usesProxy()) return (await proxyPost<{ text: string }>('/v1/generate', { parts })).text;
    const json = await googlePost(LLM_MODEL, 'generateContent', {
      contents: [{ parts }],
      generationConfig: { temperature: 0 },
    });
    const out: unknown[] = json.candidates?.[0]?.content?.parts ?? [];
    // Skip reasoning ("thought") parts if the model returns any; only the final answer is wanted.
    return out.filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('').trim();
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    if (usesProxy()) return (await proxyPost<{ values: number[] }>('/v1/embed', { text })).values;
    const json = await googlePost(EMBED_MODEL, 'embedContent', {
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
    });
    return json.embedding.values as number[];
  }
}

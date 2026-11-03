import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { CapgoLLM } from '@capgo/capacitor-llm';

import type { LlmClient } from '../interfaces';
import { LOCAL_MODEL, type LocalModelView } from './localModel';

export { LOCAL_MODEL };

const PATH_KEY = 'kaagaz_local_model_path';
const TIMEOUT_MS = 180_000;

/**
 * The plugin never frees a chat once it is created; it only does so when the model is reloaded, and each
 * chat can hold a large memory cache. So the model is reloaded after this many requests.
 */
const RECYCLE_AFTER = 4;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memoryStore = (): KeyValueStore => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

/**
 * Capacitor plugins reject with `{ message, code }`, and this one puts the real reason in `code`
 * (`reject("Failed to load model", reason)`). Showing only `message` hides why loading failed.
 */
export function errorText(e: unknown): string {
  if (e && typeof e === 'object') {
    const { message, code } = e as { message?: unknown; code?: unknown };
    const m = typeof message === 'string' ? message : '';
    const c = typeof code === 'string' ? code : '';
    if (m && c && c !== m) return `${m}: ${c}`;
    if (m || c) return m || c;
  }
  return String(e);
}

/** Adds advice when the reason looks like the phone ran out of memory. */
export function explainLoadError(reason: string): string {
  const memory = /memory|alloc|oom|mmap|bad_alloc|resource exhausted/i.test(reason);
  return memory ? `${reason}. This phone may not have enough free memory: close other apps and try again.` : reason;
}

const defaultStore = (): KeyValueStore => (typeof localStorage === 'undefined' ? memoryStore() : localStorage);

export class OnDeviceLlmClient implements LlmClient, LocalModelView {
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  private chatsSinceLoad = 0;

  /** [pollMs] is how often download progress is read from the file on disk. */
  constructor(
    private store: KeyValueStore = defaultStore(),
    private pollMs = 1000,
  ) {}

  /** Only the Android app can run the model. */
  isSupported = () => Capacitor.getPlatform() === 'android';

  isInstalled = () => this.isSupported() && this.store.getItem(PATH_KEY) !== null;

  // Download state lives here (not in a screen), so progress survives switching tabs.
  private percent: number | null = null;
  private error = '';
  private inflight: Promise<void> | null = null;
  private subs = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  downloadPercent = () => this.percent;
  lastError = () => this.error;

  /** Why the downloaded model could not start, or an empty string. */
  private startError = '';
  loadError = () => this.startError;

  /** Tries to start the model again without downloading it again. */
  async retryLoad(): Promise<void> {
    this.loaded = false;
    try {
      await this.ensureLoaded();
    } finally {
      this.notify();
    }
  }

  /** Forgets the downloaded model and downloads it again, for a file that is damaged. */
  redownload(): Promise<void> {
    this.store.removeItem(PATH_KEY);
    this.loaded = false;
    this.startError = '';
    return this.download();
  }

  private notify() {
    this.subs.forEach((fn) => fn());
  }

  /** Downloads the model (about 2.6 GB). A second call while one is running joins it. */
  download(onProgress?: (percent: number) => void): Promise<void> {
    this.inflight ??= this.fetchModel(onProgress).finally(() => {
      this.inflight = null;
      this.percent = null;
      this.notify();
    });
    return this.inflight;
  }

  private async fetchModel(onProgress?: (percent: number) => void): Promise<void> {
    if (!this.isSupported()) throw new Error('Offline Gemma 4 runs in the Android app.');
    this.error = '';
    this.percent = 0;
    this.notify();
    const report = (percent: number) => {
      if (percent === this.percent) return;
      this.percent = percent;
      onProgress?.(percent);
      this.notify();
    };
    const handle = await CapgoLLM.addListener('downloadProgress', (e) => report(e.progress));
    // The plugin reads the file size as a 32-bit number, so for a file over 2 GB it never reports progress.
    // Instead, watch the partial file grow. It never reaches 100 here: that is for when the download is done.
    const watcher = setInterval(() => void this.readProgress(report), this.pollMs);
    try {
      const { path } = await CapgoLLM.downloadModel({ url: LOCAL_MODEL.url, filename: LOCAL_MODEL.filename });
      await this.checkComplete();
      this.store.setItem(PATH_KEY, path);
      this.loaded = false;
      await this.ensureLoaded();
    } catch (e) {
      this.error = errorText(e);
      throw e;
    } finally {
      clearInterval(watcher);
      await handle.remove();
    }
  }

  private async readProgress(report: (percent: number) => void): Promise<void> {
    try {
      const { size } = await Filesystem.stat({ path: LOCAL_MODEL.filename, directory: Directory.Data });
      report(Math.max(this.percent ?? 0, Math.min(99, Math.floor((size * 100) / LOCAL_MODEL.bytes))));
    } catch {
      // The file does not exist yet.
    }
  }

  /** A connection that drops can leave a short file behind; a model that size would not load or would give garbage. */
  private async checkComplete(): Promise<void> {
    const { size } = await Filesystem.stat({ path: LOCAL_MODEL.filename, directory: Directory.Data });
    if (size < LOCAL_MODEL.bytes) {
      throw new Error(`The download stopped early (${Math.round((size * 100) / LOCAL_MODEL.bytes)}%). Try again on a stable connection.`);
    }
  }

  /** Calls run one at a time: the model handles a single request at once. */
  complete(prompt: string): Promise<string> {
    const next = this.queue.then(() => this.run(prompt));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async completeWithImage(): Promise<string> {
    throw new Error('Reading images needs the online model.');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const path = this.store.getItem(PATH_KEY);
    if (!path) throw new Error('Offline Gemma 4 is not installed. Download it in Settings.');
    try {
      await CapgoLLM.setModel({ path, modelType: 'litertlm', maxTokens: 4096, topk: 40, temperature: 0.2 });
    } catch (e) {
      this.startError = explainLoadError(errorText(e));
      this.notify();
      throw new Error(`Gemma 4 could not start: ${this.startError}`);
    }
    this.loaded = true;
    this.chatsSinceLoad = 0;
    if (this.startError) {
      this.startError = '';
      this.notify();
    }
  }

  private async run(prompt: string): Promise<string> {
    if (this.chatsSinceLoad >= RECYCLE_AFTER) this.loaded = false; // reload to free the finished chats
    await this.ensureLoaded();
    const { id } = await CapgoLLM.createChat();
    this.chatsSinceLoad++;
    const subs: { remove: () => Promise<void> }[] = [];
    try {
      return await new Promise<string>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error('On-device Gemma 4 took too long.')), TIMEOUT_MS);
        const settle = (fn: () => void) => {
          clearTimeout(timer);
          fn();
        };
        void (async () => {
          subs.push(
            await CapgoLLM.addListener('textFromAi', (e) => {
              if (e.chatId === id) text = e.isChunk === false ? e.text : text + e.text;
            }),
            await CapgoLLM.addListener('aiFinished', (e) => {
              if (e.chatId === id) settle(() => resolve(text.trim()));
            }),
            await CapgoLLM.addListener('generationError', (e) => {
              if (!e.chatId || e.chatId === id) settle(() => reject(new Error(e.error)));
            }),
          );
          await CapgoLLM.sendMessage({ chatId: id, message: prompt });
        })().catch((err) => settle(() => reject(err)));
      });
    } finally {
      await Promise.all(subs.map((s) => s.remove().catch(() => undefined)));
    }
  }
}

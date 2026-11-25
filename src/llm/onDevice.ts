import { Capacitor, registerPlugin } from '@capacitor/core';
import { CapgoLLM } from '@capgo/capacitor-llm';

import type { LlmClient } from '../interfaces';
import { LOCAL_MODEL, type LocalModelView } from './localModel';

export { LOCAL_MODEL };

const PATH_KEY = 'kaagaz_local_model_path';
/** The Android download in progress, so a download started before the app closed is picked up again. */
const DOWNLOAD_KEY = 'kaagaz_local_model_download';

export interface DownloadStatus {
  state: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'missing';
  bytes: number;
  /** -1 until the server has said. */
  total: number;
  /** Why it failed, or why it is paused ('network', 'wifi', 'retry', 'paused'). */
  reason: string;
  path: string;
}

/** Android's DownloadManager (android/app/src/main/java/app/kaagaz/ModelDownloadPlugin.java). */
export interface BackgroundDownloader {
  start(o: { url: string; filename: string; title: string; description: string }): Promise<{ id: string }>;
  status(o: { id: string }): Promise<DownloadStatus>;
}

const nativeDownloader = (): BackgroundDownloader => registerPlugin<BackgroundDownloader>('ModelDownload');
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

  /** [pollMs] is how often the download's progress is read. */
  constructor(
    private store: KeyValueStore = defaultStore(),
    private pollMs = 1000,
    private downloader: BackgroundDownloader = nativeDownloader(),
  ) {}

  /** Picks up a download that was running when the app closed. Call once at startup. */
  resumePending(): void {
    if (this.isSupported() && !this.isInstalled() && this.store.getItem(DOWNLOAD_KEY)) {
      void this.download().catch(() => undefined);
    }
  }

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
  private pause = '';
  downloadPause = () => this.pause;

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
      this.pause = '';
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
    try {
      const path = await this.transfer(report);
      this.store.setItem(PATH_KEY, path);
      this.loaded = false;
      await this.ensureLoaded();
    } catch (e) {
      this.error = errorText(e);
      throw e;
    }
  }

  /**
   * Android's DownloadManager does the transfer, so it carries on with the app in the background or
   * the screen off, and retries when the network drops. This only starts it (or rejoins the one already
   * running) and reads its progress. Resolves with the file's path once the whole file is there.
   */
  private async transfer(report: (percent: number) => void): Promise<string> {
    let id = this.store.getItem(DOWNLOAD_KEY);
    if (id) {
      const { state } = await this.downloader.status({ id });
      if (state === 'failed' || state === 'missing') id = null;
    }
    if (!id) {
      ({ id } = await this.downloader.start({
        url: LOCAL_MODEL.url,
        filename: LOCAL_MODEL.filename,
        title: `${LOCAL_MODEL.name} for Kaagaz`,
        description: `Offline model, ${LOCAL_MODEL.sizeLabel}`,
      }));
      this.store.setItem(DOWNLOAD_KEY, id);
    }

    for (;;) {
      const s = await this.downloader.status({ id });
      if (s.state === 'done') {
        this.store.removeItem(DOWNLOAD_KEY);
        // A model cut short would not load, or would give garbage.
        if (s.bytes < LOCAL_MODEL.bytes) {
          throw new Error(`The download stopped early (${Math.round((s.bytes * 100) / LOCAL_MODEL.bytes)}%). Try again on a stable connection.`);
        }
        return s.path;
      }
      if (s.state === 'failed' || s.state === 'missing') {
        this.store.removeItem(DOWNLOAD_KEY);
        throw new Error(s.reason || 'The download failed. Try again.');
      }
      const pause = s.state === 'paused' ? s.reason : '';
      if (pause !== this.pause) {
        this.pause = pause;
        this.notify();
      }
      // 100 is for when the model is ready, and progress never goes backwards.
      report(Math.max(this.percent ?? 0, Math.min(99, Math.floor((s.bytes * 100) / LOCAL_MODEL.bytes))));
      await new Promise((r) => setTimeout(r, this.pollMs));
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

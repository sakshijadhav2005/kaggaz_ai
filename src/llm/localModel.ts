/** Gemma 4 E2B, the phone-sized Gemma 4 (LiteRT-LM). About 2.6 GB, so it is downloaded on request. */
export const LOCAL_MODEL = {
  name: 'Gemma 4 E2B',
  sizeLabel: '2.6 GB',
  /** Exact size of the file, used to show progress and to detect a download that was cut short. */
  bytes: 2_588_147_712,
  url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm?download=true',
  filename: 'gemma-4-E2B-it.litertlm',
};

/** What the screens need to show and start the on-device model. */
export interface LocalModelView {
  /** Only the Android app can run the model. */
  isSupported(): boolean;
  isInstalled(): boolean;
  /** 0 to 100 while downloading, otherwise null. */
  downloadPercent(): number | null;
  /** The last download error, or an empty string. */
  lastError(): string;
  /** Why the downloaded model could not start (for example, not enough memory), or an empty string. */
  loadError(): string;
  /** Start the downloaded model again without downloading it again. */
  retryLoad(): Promise<unknown>;
  /** Delete the downloaded model's record and download it again. */
  redownload(): Promise<unknown>;
  /** Calls [fn] whenever the status or progress changes. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  download(): Promise<unknown>;
}

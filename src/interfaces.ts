import type { ClassificationResult, ExtractedSegment, StoredFile } from './models';

export interface Extractor {
  canHandle(file: StoredFile): boolean;
  extract(file: StoredFile): Promise<ExtractedSegment[]>;
}

export interface Classifier {
  classify(file: StoredFile, text: string): Promise<ClassificationResult | null>;
}

/** All Gemma calls go through here. `completeWithImage` is the one addition to the spec's interface. */
export interface LlmClient {
  complete(prompt: string): Promise<string>;
  completeWithImage(prompt: string, base64: string, mimeType: string): Promise<string>;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface ReminderScheduler {
  schedule(id: number, title: string, at: Date): Promise<void>;
  cancel(id: number): Promise<void>;
}

/** App-private file storage. Folders are subdirectories. */
export interface VaultStore {
  /** Stores [data] under [folder] and returns its path. */
  store(data: Blob, name: string, id: string, folder: string): Promise<string>;
  /** Physical move inside the vault; returns the new path. */
  move(path: string, folder: string): Promise<string>;
  read(path: string, name: string): Promise<Blob>;
  remove(path: string): Promise<void>;
}

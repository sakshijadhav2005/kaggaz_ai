/** Data shapes shared by every module. */

export const FOLDERS = ['Aadhaar', 'PAN', 'Bills', 'Receipts', 'Medical', 'Study', 'Other', 'Unsorted'] as const;
export type Folder = (typeof FOLDERS)[number];

/** Folders a classifier may choose; `Unsorted` is only the fallback. */
export const CLASSIFIABLE: readonly Folder[] = ['Aadhaar', 'PAN', 'Bills', 'Receipts', 'Medical', 'Study', 'Other'];

export const SORT_THRESHOLD = 0.6;

export const IMPORT_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'mp3', 'm4a', 'wav', 'aac', 'ogg'];

export type FileType = 'pdf' | 'image' | 'audio' | 'other';
export type FileStatus = 'processing' | 'ready' | 'needs_review';
export type SortSource = 'rule' | 'gemma' | 'manual';

const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

export function fileTypeFor(name: string): FileType {
  const ext = extOf(name);
  if (ext === 'pdf') return 'pdf';
  if (['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext)) return 'image';
  if (['mp3', 'm4a', 'wav', 'aac', 'ogg'].includes(ext)) return 'audio';
  return 'other';
}

export function mimeFor(name: string): string {
  const ext = extOf(name);
  const known: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
  };
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return known[ext] ?? 'application/octet-stream';
}

export interface StoredFile {
  id: string;
  name: string;
  type: FileType;
  path: string;
  folder: Folder;
  status: FileStatus;
  source: SortSource;
  language: string;
  importedAt: number;
  /** Full extracted text; used for re-sorting and editing. */
  text: string;
  favorite?: boolean;
  /** Set when moved to Trash; the file is hidden everywhere until restored. */
  deletedAt?: number;
  /**
   * Needs fingerprint or screen lock to open. The assistant cannot use it, and its text never goes to the
   * cloud: it is left out of answers, embeddings and PDF tools.
   */
  locked?: boolean;
}

export interface ExtractedSegment {
  page?: number; // PDF and images
  startMs?: number; // audio: where the passage starts (0: the whole recording is one passage)
  text: string;
  language: string; // 'en', 'hi', ...
  confidence: number;
  method: 'pdf_text' | 'ocr_device' | 'ocr_gemma' | 'audio_transcript' | 'manual';
}

export const fullText = (segments: ExtractedSegment[]) =>
  segments
    .map((s) => s.text)
    .filter((t) => t.trim() !== '')
    .join('\n\n');

export const avgConfidence = (segments: ExtractedSegment[]) =>
  segments.length === 0 ? 0 : segments.reduce((a, s) => a + s.confidence, 0) / segments.length;

export function statusFor(segments: ExtractedSegment[]): FileStatus {
  return fullText(segments).trim() === '' || avgConfidence(segments) < 0.5 ? 'needs_review' : 'ready';
}

export interface ClassificationResult {
  folder: Folder;
  confidence: number;
  source: 'rule' | 'gemma';
}

export interface Chunk {
  id?: number;
  fileId: string;
  text: string;
  page?: number;
  language: string;
  embedding?: number[];
}

export interface RecordRow {
  fileId: string;
  kind: 'bill' | 'receipt';
  vendor?: string;
  amount?: number;
  currency: string;
  docDate?: number;
  dueDate?: number;
}

export interface Reminder {
  id?: number;
  fileId: string;
  title: string;
  dueAt: number;
  done: boolean;
}

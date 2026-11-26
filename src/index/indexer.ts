import type { Db } from '../core/db';
import type { EmbeddingProvider, Extractor } from '../interfaces';
import { detectLanguage } from '../extract/textUtils';
import type { Chunk, ExtractedSegment } from '../models';
import { chunkSegments } from './chunker';

const RECHUNK_FLAG = 'kaagaz.imageChunksKeepLines';

/**
 * One-time repair for images indexed before chunks kept line breaks: without them the
 * mobile-number finder cannot tell a card's mobile number from the Aadhaar number on the
 * next line. Rebuilds each image's chunks from its saved text (which kept the line breaks),
 * so no OCR is re-run, and folders, names and edited text stay as they are. Embeddings are
 * rebuilt by embedMissing. A file that fails is retried on the next launch.
 */
export async function rechunkImages(db: Db, indexer: Indexer): Promise<number> {
  if (readFlag(RECHUNK_FLAG)) return 0;
  let done = 0;
  let failures = 0;
  for (const f of await db.allFilesIncludingTrash()) {
    if (f.type !== 'image' || f.text.trim() === '') continue;
    try {
      const page = await db.firstChunkPage(f.id);
      await indexer.store(f.id, [{ page, text: f.text, language: detectLanguage(f.text), confidence: 1, method: 'ocr_device' }]);
      done++;
    } catch (e) {
      failures++;
      console.error(`Could not re-index ${f.id}:`, e);
    }
  }
  if (failures === 0) writeFlag(RECHUNK_FLAG);
  return done;
}

const PDF_RECHUNK_FLAG = 'kaagaz.pdfChunksKeepLines';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * One-time repair for PDFs indexed before chunks kept line breaks. A PDF's saved text no longer
 * says where each page starts, so the file is read again with [pdf] (give it one that never goes
 * online). A page takes the new chunks only when they match the stored ones word for word, so the
 * repair restores line breaks and nothing else; a page that reads differently now keeps its old
 * chunks. PDFs whose text the user edited are rebuilt from that text. Returns how many files changed.
 */
export async function rechunkPdfs(db: Db, pdf: Extractor): Promise<number> {
  if (readFlag(PDF_RECHUNK_FLAG)) return 0;
  let updated = 0;
  let failures = 0;
  for (const f of await db.allFilesIncludingTrash()) {
    if (f.type !== 'pdf' || f.text.trim() === '') continue;
    try {
      const old = await db.chunksForFile(f.id);
      if (old.length === 0) continue;

      if (old.some((c) => c.page === undefined)) {
        // Edited by the user: the saved text is the source, line breaks included.
        const chunks = chunkSegments([{ text: f.text, language: detectLanguage(f.text), confidence: 1, method: 'manual' }]);
        await db.replaceChunks(f.id, chunks.map((c) => ({ fileId: f.id, text: c.text, language: c.language })));
        updated++;
        continue;
      }

      const fresh = chunkSegments(await pdf.extract(f));
      const out: Chunk[] = [];
      let changed = false;
      for (const page of [...new Set(old.map((c) => c.page))]) {
        const before = old.filter((c) => c.page === page);
        const after = fresh.filter((c) => c.page === page);
        const same = after.length === before.length && after.every((c, i) => flat(c.text) === flat(before[i].text));
        if (same && after.some((c, i) => c.text !== before[i].text)) {
          out.push(...after.map((c) => ({ fileId: f.id, text: c.text, page, language: c.language })));
          changed = true;
        } else {
          out.push(...before.map(({ id: _id, ...c }) => c));
        }
      }
      if (changed) {
        await db.replaceChunks(f.id, out);
        updated++;
      }
    } catch (e) {
      failures++;
      console.error(`Could not re-index ${f.id}:`, e);
    }
  }
  if (failures === 0) writeFlag(PDF_RECHUNK_FLAG);
  return updated;
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Without the flag the repair runs again next launch, which is slower but harmless.
  }
}

/**
 * Chunk text, then embed. Embedding needs the network, so chunks are stored
 * first and `embedMissing` fills in vectors whenever it can.
 */
export class Indexer {
  constructor(
    private db: Db,
    private embedder: EmbeddingProvider,
  ) {}

  store(fileId: string, segments: ExtractedSegment[]) {
    return this.db.replaceChunks(
      fileId,
      chunkSegments(segments).map((c) => ({ fileId, text: c.text, page: c.page, language: c.language })),
    );
  }

  /** Best effort: stops quietly on the first failure (offline, quota) and retries next time. */
  async embedMissing(): Promise<void> {
    try {
      for (;;) {
        const batch = await this.db.chunksMissingEmbedding();
        if (batch.length === 0) return;
        for (const c of batch) await this.db.setChunkEmbedding(c.id!, await this.embedder.embed(c.text));
      }
    } catch {
      // Retried on the next import or app start.
    }
  }
}

import type { Db } from '../core/db';
import type { EmbeddingProvider } from '../interfaces';
import type { ExtractedSegment } from '../models';
import { chunkSegments } from './chunker';

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

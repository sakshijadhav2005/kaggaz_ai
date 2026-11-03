import '../core/db.dart';
import '../interfaces.dart';
import '../models.dart';
import 'chunker.dart';

/// Chunk text, then embed. Embedding needs the network, so chunks are stored
/// first and [embedMissing] fills in vectors whenever it can.
class Indexer {
  Indexer({required this.db, required this.embedder});

  final Db db;
  final EmbeddingProvider embedder;

  Future<void> store(String fileId, List<ExtractedSegment> segments) => db.replaceChunks(fileId, [
        for (final c in chunkSegments(segments)) Chunk(fileId: fileId, text: c.text, page: c.page, language: c.language),
      ]);

  /// Best effort: stops quietly on the first failure (offline, quota) and retries next time.
  Future<void> embedMissing() async {
    try {
      while (true) {
        final batch = await db.chunksMissingEmbedding();
        if (batch.isEmpty) return;
        for (final c in batch) {
          await db.setChunkEmbedding(c.id!, await embedder.embed(c.text));
        }
      }
    } catch (_) {
      // Retried on the next import or app start.
    }
  }
}

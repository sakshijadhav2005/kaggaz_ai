import '../core/db.dart';
import '../index/vector.dart';
import '../interfaces.dart';

const kNotFound = "I couldn't find this in your files.";

/// One copy of the answer prompt, used everywhere.
const kAnswerPrompt =
    'Answer only from the excerpts below. Cite excerpt IDs in square brackets. '
    'Answer in the language of the question. If the answer is not in the excerpts, say '
    '"$kNotFound" Never invent numbers or dates.';

/// Tune on real data; depends on the embedding model.
const kMinScore = 0.5;
const kTopK = 6;

class Citation {
  const Citation({required this.fileId, required this.fileName, required this.folder, this.page});

  final String fileId, fileName, folder;
  final int? page;
}

class Answer {
  const Answer(this.text, this.citations);

  final String text;
  final List<Citation> citations;
}

String buildAnswerPrompt(String question, List<String> excerpts) {
  final body = [for (var i = 0; i < excerpts.length; i++) '[${i + 1}] ${excerpts[i]}'].join('\n\n');
  return '$kAnswerPrompt\n\nExcerpts:\n$body\n\nQuestion: $question';
}

/// Excerpt IDs the model cited, in order, without duplicates. Handles `[1]` and `[1, 2]`.
List<int> citedIds(String reply) {
  final ids = <int>[];
  for (final m in RegExp(r'\[(\d+(?:\s*,\s*\d+)*)\]').allMatches(reply)) {
    for (final part in m.group(1)!.split(',')) {
      final id = int.parse(part.trim());
      if (!ids.contains(id)) ids.add(id);
    }
  }
  return ids;
}

class Answerer {
  Answerer({required this.db, required this.embedder, required this.llm});

  final Db db;
  final EmbeddingProvider embedder;
  final LlmClient llm;

  Future<Answer> ask(String question) async {
    final qv = await embedder.embed(question);
    final top = topK(qv, await db.chunksWithEmbeddings(), kTopK);
    if (top.isEmpty || top.first.score < kMinScore) return const Answer(kNotFound, []);

    final reply = (await llm.complete(buildAnswerPrompt(question, [for (final s in top) s.item.text]))).trim();

    // The app, not the model, supplies file names and pages.
    final cites = <Citation>[];
    for (final id in citedIds(reply)) {
      if (id < 1 || id > top.length) continue;
      final chunk = top[id - 1].item;
      if (cites.any((c) => c.fileId == chunk.fileId && c.page == chunk.page)) continue;
      final file = await db.getFile(chunk.fileId);
      if (file == null) continue;
      cites.add(Citation(fileId: file.id, fileName: file.name, folder: file.folder, page: chunk.page));
    }
    return Answer(reply, cites);
  }
}

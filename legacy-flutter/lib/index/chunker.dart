import '../models.dart';

class TextChunk {
  const TextChunk(this.text, this.page, this.language);

  final String text;
  final int? page;
  final String language;
}

/// Splits each segment into overlapping chunks. Words stand in for tokens.
/// Never merges across segments (pages).
List<TextChunk> chunkSegments(List<ExtractedSegment> segments, {int size = 400, int overlap = 50}) {
  final out = <TextChunk>[];
  for (final seg in segments) {
    final words = seg.text.split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) continue;
    var start = 0;
    while (true) {
      final end = start + size < words.length ? start + size : words.length;
      out.add(TextChunk(words.sublist(start, end).join(' '), seg.page, seg.language));
      if (end >= words.length) break;
      start = end - overlap;
    }
  }
  return out;
}

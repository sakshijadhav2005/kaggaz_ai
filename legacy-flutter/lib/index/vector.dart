import 'dart:math' as math;

import '../models.dart';

class Scored<T> {
  const Scored(this.item, this.score);

  final T item;
  final double score;
}

double cosine(List<double> a, List<double> b) {
  if (a.length != b.length || a.isEmpty) return 0;
  var dot = 0.0, na = 0.0, nb = 0.0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na == 0 || nb == 0) return 0;
  return dot / (math.sqrt(na) * math.sqrt(nb));
}

/// Brute-force search; fine at MVP scale.
List<Scored<Chunk>> topK(List<double> query, Iterable<Chunk> chunks, int k) {
  final scored = [
    for (final c in chunks)
      if (c.embedding != null) Scored(c, cosine(query, c.embedding!)),
  ]..sort((a, b) => b.score.compareTo(a.score));
  return scored.take(k).toList();
}

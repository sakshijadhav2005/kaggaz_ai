/// 'hi' when Devanagari dominates the letters, otherwise 'en'.
String detectLanguage(String text) {
  final letters = RegExp(r'\p{L}', unicode: true).allMatches(text).length;
  if (letters == 0) return 'en';
  final deva = RegExp(r'[ऀ-ॿ]').allMatches(text).length;
  return deva / letters > 0.3 ? 'hi' : 'en';
}

/// Rough 0..1 heuristic: empty or mostly symbols means low. Tune on real photos.
double textConfidence(String text) {
  final s = text.replaceAll(RegExp(r'\s'), '');
  if (s.isEmpty) return 0;
  if (s.length < 10) return 0.2;
  final good = RegExp(r'[\p{L}\p{N}\p{M}]', unicode: true).allMatches(s).length;
  return (good / s.length).clamp(0.0, 1.0).toDouble();
}

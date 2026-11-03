import 'dart:convert';

import '../interfaces.dart';
import '../models.dart';

String buildClassifierPrompt(String text) => '''
Classify this document into exactly one of these folders:
${kClassifiable.join(', ')}.
Return only JSON: {"folder": "<name>", "confidence": <0.0-1.0>}
If unsure, use "Other" with low confidence. Do not add any other text.

Document text:
${text.length > 2000 ? text.substring(0, 2000) : text}''';

/// Parses the model reply; anything unparseable becomes `Unsorted`.
ClassificationResult parseClassifierReply(String reply) {
  const failed = ClassificationResult(folder: 'Unsorted', confidence: 0, source: 'gemma');
  final match = RegExp(r'\{.*\}', dotAll: true).firstMatch(reply);
  if (match == null) return failed;
  try {
    final json = jsonDecode(match.group(0)!) as Map<String, dynamic>;
    final folder = json['folder'];
    final confidence = json['confidence'];
    if (folder is! String || !kClassifiable.contains(folder) || confidence is! num) return failed;
    return ClassificationResult(
      folder: folder,
      confidence: confidence.toDouble().clamp(0.0, 1.0).toDouble(),
      source: 'gemma',
    );
  } catch (_) {
    return failed;
  }
}

/// Online second pass, used only when no rule matched.
class GemmaClassifier implements Classifier {
  GemmaClassifier(this._llm);

  final LlmClient _llm;

  @override
  Future<ClassificationResult?> classify(StoredFile file, String text) async {
    if (text.trim().isEmpty) return null;
    return parseClassifierReply(await _llm.complete(buildClassifierPrompt(text)));
  }
}

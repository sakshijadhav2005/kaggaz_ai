import 'dart:typed_data';

import 'models.dart';

abstract class Extractor {
  bool canHandle(StoredFile file);
  Future<ExtractionResult> extract(StoredFile file);
}

abstract class Classifier {
  Future<ClassificationResult?> classify(StoredFile file, String text);
}

/// All Gemma calls go through here. `completeWithImage` is the one addition to
/// the spec's interface: the OCR fallback needs to send an image.
abstract class LlmClient {
  Future<String> complete(String prompt);
  Future<String> completeWithImage(String prompt, Uint8List bytes, String mimeType);
}

abstract class ReminderScheduler {
  Future<void> schedule(int id, String title, DateTime at);
  Future<void> cancel(int id);
}

abstract class EmbeddingProvider {
  Future<List<double>> embed(String text);
}

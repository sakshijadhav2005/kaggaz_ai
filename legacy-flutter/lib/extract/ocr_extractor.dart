import 'dart:io';

import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';

import '../interfaces.dart';
import '../models.dart';
import 'text_utils.dart';

const _gemmaOcrPrompt =
    'Transcribe all text visible in this image exactly as written. Do not translate. '
    'If unreadable, write [unreadable]. Return only the transcription.';

/// Device OCR (Latin + Devanagari) with a Gemma fallback when the result is weak and we are online.
class OcrExtractor implements Extractor {
  OcrExtractor({this.llm, required this.isOnline});

  final LlmClient? llm;
  final Future<bool> Function() isOnline;

  @override
  bool canHandle(StoredFile file) => file.type == 'image';

  @override
  Future<ExtractionResult> extract(StoredFile file) async =>
      ExtractionResult([await recognize(file.path, page: 1)]);

  Future<ExtractedSegment> recognize(String imagePath, {int? page}) async {
    final input = InputImage.fromFilePath(imagePath);
    final latin = await _run(TextRecognitionScript.latin, input);
    final devanagari = await _run(TextRecognitionScript.devanagiri, input);
    // Both scripts return something; keep whichever looks like real text.
    final text = _score(devanagari) > _score(latin) ? devanagari : latin;
    var seg = _segment(text, page, 'ocr_device');

    if (seg.confidence < 0.5 && llm != null && await isOnline()) {
      try {
        final bytes = await File(imagePath).readAsBytes();
        final mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        final reply = await llm!.completeWithImage(_gemmaOcrPrompt, bytes, mime);
        if (!reply.contains('[unreadable]') && reply.trim().length > text.trim().length) {
          seg = _segment(reply, page, 'ocr_gemma');
        }
      } catch (_) {
        // Keep the device result.
      }
    }
    return seg;
  }

  Future<String> _run(TextRecognitionScript script, InputImage input) async {
    final recognizer = TextRecognizer(script: script);
    try {
      return (await recognizer.processImage(input)).text;
    } finally {
      await recognizer.close();
    }
  }

  double _score(String t) => t.length * textConfidence(t);

  ExtractedSegment _segment(String text, int? page, String method) => ExtractedSegment(
        page: page,
        text: text.trim(),
        language: detectLanguage(text),
        confidence: textConfidence(text),
        method: method,
      );
}

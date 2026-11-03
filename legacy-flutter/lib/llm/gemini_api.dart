import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../interfaces.dart';

/// Pass at build time: flutter run --dart-define=GEMINI_API_KEY=...
/// Later this moves behind the backend proxy; only the classes below change.
class ApiConfig {
  static const key = String.fromEnvironment('GEMINI_API_KEY');
  static const llmModel = String.fromEnvironment('LLM_MODEL', defaultValue: 'gemma-3-27b-it');
  static const embedModel = String.fromEnvironment('EMBED_MODEL', defaultValue: 'gemini-embedding-001');
}

const _base = 'https://generativelanguage.googleapis.com/v1beta/models';

Future<Map<String, dynamic>> _post(String model, String method, Map<String, Object?> body) async {
  final res = await http
      .post(
        Uri.parse('$_base/$model:$method'),
        headers: {'x-goog-api-key': ApiConfig.key, 'content-type': 'application/json'},
        body: jsonEncode(body),
      )
      .timeout(const Duration(seconds: 60));
  if (res.statusCode != 200) {
    throw Exception('Gemini API ${res.statusCode}: ${res.body}');
  }
  return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
}

class GemmaLlmClient implements LlmClient {
  @override
  Future<String> complete(String prompt) => _generate([
        {'text': prompt},
      ]);

  @override
  Future<String> completeWithImage(String prompt, Uint8List bytes, String mimeType) => _generate([
        {
          'inline_data': {'mime_type': mimeType, 'data': base64Encode(bytes)},
        },
        {'text': prompt},
      ]);

  Future<String> _generate(List<Map<String, Object?>> parts) async {
    final json = await _post(ApiConfig.llmModel, 'generateContent', {
      'contents': [
        {'parts': parts},
      ],
      'generationConfig': {'temperature': 0},
    });
    final candidates = json['candidates'] as List?;
    final content = candidates == null || candidates.isEmpty ? null : candidates.first['content'];
    final out = (content?['parts'] as List?)?.map((p) => p['text'] ?? '').join() ?? '';
    return out.trim();
  }
}

class GeminiEmbeddingProvider implements EmbeddingProvider {
  @override
  Future<List<double>> embed(String text) async {
    final json = await _post(ApiConfig.embedModel, 'embedContent', {
      'model': 'models/${ApiConfig.embedModel}',
      'content': {
        'parts': [
          {'text': text},
        ],
      },
    });
    final values = (json['embedding'] as Map<String, dynamic>)['values'] as List;
    return values.map((v) => (v as num).toDouble()).toList(growable: false);
  }
}

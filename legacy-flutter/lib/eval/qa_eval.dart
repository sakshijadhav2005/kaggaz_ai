import 'dart:convert';

import '../answer/answerer.dart';

class QaCase {
  QaCase.fromJson(Map<String, dynamic> j)
      : question = j['question'] as String,
        expect = j['expect'] as String?,
        file = j['file'] as String?;

  final String question;

  /// Text the answer must contain; null means the answer must be "not found".
  final String? expect;

  /// Part of the file name the citations must include (case-insensitive).
  final String? file;
}

class QaOutcome {
  const QaOutcome(this.testCase, this.answer, this.passed);

  final QaCase testCase;
  final String answer;
  final bool passed;
}

List<QaCase> parseQaCases(String json) =>
    (jsonDecode(json) as List).map((e) => QaCase.fromJson(e as Map<String, dynamic>)).toList();

/// Pass = answer has the expected text AND cites the expected file.
/// For unanswerable questions, pass = the model says it couldn't find it.
bool judge(QaCase c, Answer a) {
  if (c.expect == null) return a.text.contains(kNotFound);
  if (!a.text.toLowerCase().contains(c.expect!.toLowerCase())) return false;
  final f = c.file?.toLowerCase();
  return f == null || a.citations.any((x) => x.fileName.toLowerCase().contains(f));
}

Future<List<QaOutcome>> runQaEval(List<QaCase> cases, Future<Answer> Function(String) ask) async {
  final out = <QaOutcome>[];
  for (final c in cases) {
    try {
      final a = await ask(c.question);
      out.add(QaOutcome(c, a.text, judge(c, a)));
    } catch (e) {
      out.add(QaOutcome(c, 'ERROR: $e', false));
    }
  }
  return out;
}

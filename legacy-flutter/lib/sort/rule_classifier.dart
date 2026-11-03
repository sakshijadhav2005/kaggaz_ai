import 'dart:convert';

import '../interfaces.dart';
import '../models.dart';
import '../search/folder_search.dart';

const _ruleConfidence = 0.9;
const _filenameConfidence = 0.6;

class _Condition {
  _Condition(Map<String, dynamic> json)
      : anyText = (json['any_text'] as List?)?.map((e) => (e as String).toLowerCase()).toList(),
        regex = json['regex'] == null ? null : RegExp(json['regex'] as String);

  final List<String>? anyText;
  final RegExp? regex;

  bool matches(String text, String lower) {
    if (anyText != null) return anyText!.any(lower.contains);
    return regex!.hasMatch(text);
  }
}

class _Rule {
  _Rule(Map<String, dynamic> json)
      : folder = json['folder'] as String,
        all = _conds(json['all']),
        any = _conds(json['any']);

  final String folder;
  final List<_Condition> all, any;

  static List<_Condition> _conds(Object? raw) =>
      ((raw as List?) ?? const []).map((e) => _Condition(e as Map<String, dynamic>)).toList();

  bool matches(String text, String lower) {
    if (all.isEmpty && any.isEmpty) return false;
    return all.every((c) => c.matches(text, lower)) &&
        (any.isEmpty || any.any((c) => c.matches(text, lower)));
  }
}

/// Offline first pass. Rules live in assets/rules.json; first match wins.
class RuleClassifier implements Classifier {
  RuleClassifier(this._rules);

  factory RuleClassifier.fromJson(String json) => RuleClassifier(
        (jsonDecode(json) as List).map((e) => _Rule(e as Map<String, dynamic>)).toList(),
      );

  final List<_Rule> _rules;

  @override
  Future<ClassificationResult?> classify(StoredFile file, String text) async =>
      classifySync(file.name, text);

  ClassificationResult? classifySync(String fileName, String text) {
    final lower = text.toLowerCase();
    for (final rule in _rules) {
      if (rule.matches(text, lower)) {
        return ClassificationResult(folder: rule.folder, confidence: _ruleConfidence, source: 'rule');
      }
    }
    // Weak signal: the file name.
    final hinted = folderForQuery(fileName);
    if (hinted != null) {
      return ClassificationResult(folder: hinted, confidence: _filenameConfidence, source: 'rule');
    }
    return null;
  }
}

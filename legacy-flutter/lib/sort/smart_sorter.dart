import '../interfaces.dart';
import '../models.dart';

/// Decides the folder only. Moving the file and saving to the DB is the
/// caller's job, so this part stays pure and easy to test.
class SmartSorter {
  SmartSorter({required this.rules, this.gemma, required this.isOnline});

  final Classifier rules;
  final Classifier? gemma;
  final Future<bool> Function() isOnline;

  Future<ClassificationResult> decide(StoredFile file, String text) async {
    var result = await rules.classify(file, text);
    if (result == null && gemma != null && await isOnline()) {
      try {
        result = await gemma!.classify(file, text);
      } catch (_) {
        // Network or API failure: fall through to Unsorted.
      }
    }
    if (result != null && result.confidence >= kSortThreshold && result.folder != 'Unsorted') {
      return result;
    }
    return ClassificationResult(folder: 'Unsorted', confidence: result?.confidence ?? 0, source: result?.source ?? 'rule');
  }
}

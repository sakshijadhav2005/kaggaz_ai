import 'dart:io';

import 'package:path/path.dart' as p;

import '../extract/text_utils.dart';
import '../index/indexer.dart';
import '../interfaces.dart';
import '../models.dart';
import '../records/record_parser.dart';
import '../sort/smart_sorter.dart';
import 'db.dart';
import 'vault.dart';

/// Wires the pipeline: import -> extract -> sort -> index -> records/reminders.
class IngestService {
  IngestService({
    required this.vault,
    required this.db,
    required this.extractors,
    required this.sorter,
    required this.indexer,
    this.scheduler,
  });

  final ReminderScheduler? scheduler;
  final Vault vault;
  final Db db;
  final List<Extractor> extractors;
  final SmartSorter sorter;
  final Indexer indexer;

  Future<StoredFile> importFile(File src) async {
    final id = DateTime.now().microsecondsSinceEpoch.toString();
    final name = p.basename(src.path);
    final copy = await vault.store(src, id, 'Unsorted');
    final file = StoredFile(
      id: id,
      name: name,
      type: fileTypeFor(name),
      path: copy.path,
      folder: 'Unsorted',
      status: 'processing',
      source: 'rule',
      language: 'en',
      importedAt: DateTime.now(),
    );
    await db.insertFile(file);
    await process(file);
    return (await db.getFile(id))!;
  }

  /// Extract and finish. Also used by Retry.
  Future<void> process(StoredFile file) async {
    file = await _fresh(file);
    final extractor = extractors.where((e) => e.canHandle(file)).firstOrNull;
    var result = ExtractionResult.empty;
    if (extractor != null) {
      try {
        result = await extractor.extract(file);
      } catch (_) {
        // Leave empty; the file lands in needs_review and the user can retry or edit.
      }
    }
    await _finish(file, result.segments, result.fullText, result.status);
  }

  /// User-edited text replaces the extraction.
  Future<void> replaceText(StoredFile file, String text) async {
    file = await _fresh(file);
    final seg = ExtractedSegment(
      text: text,
      language: detectLanguage(text),
      confidence: 1,
      method: 'manual',
    );
    return _finish(file, [seg], text, 'ready');
  }

  /// Manual folders are never changed by a re-run.
  Future<void> moveManually(StoredFile file, String folder) async {
    final path = await vault.move(file.path, folder);
    await db.updateFile(file.id, {'folder': folder, 'path': path, 'source': 'manual'});
  }

  /// A notification failure (permission denied, platform error) must not fail an import.
  Future<void> _tryNotify(Future<void>? Function() action) async {
    try {
      await action();
    } catch (_) {}
  }

  /// Callers may hold an old copy (path or source changed since).
  Future<StoredFile> _fresh(StoredFile file) async => (await db.getFile(file.id)) ?? file;

  Future<void> _finish(StoredFile file, List<ExtractedSegment> segments, String text, String status) async {
    await db.updateFile(file.id, {'text': text});
    await indexer.store(file.id, segments);

    var folder = file.folder;
    if (file.source != 'manual') {
      final decision = await sorter.decide(file, text);
      final path = await vault.move(file.path, decision.folder);
      folder = decision.folder;
      await db.updateFile(file.id, {'folder': folder, 'path': path, 'source': decision.source});
    }

    await db.updateFile(file.id, {'status': status, 'language': detectLanguage(text)});
    await _extractRecord(file, folder, text);
    await indexer.embedMissing();
  }

  Future<void> _extractRecord(StoredFile file, String folder, String text) async {
    await db.deleteRecord(file.id);
    final oldId = await db.reminderIdForFile(file.id);
    if (oldId != null) await _tryNotify(() => scheduler?.cancel(oldId));
    await db.deleteReminder(file.id);
    if (folder != 'Bills' && folder != 'Receipts') return;
    final r = parseRecord(text);
    if (r.isEmpty) return;
    await db.saveRecord(
      file.id,
      folder == 'Bills' ? 'bill' : 'receipt',
      vendor: r.vendor,
      amount: r.amount,
      docDate: r.docDate,
      dueDate: r.dueDate,
    );
    final due = r.dueDate;
    if (due != null) {
      final who = r.vendor ?? file.name;
      final amt = r.amount == null ? '' : ' (Rs ${r.amount!.toStringAsFixed(2)})';
      final title = 'Pay $who$amt';
      final at = DateTime(due.year, due.month, due.day, 9);
      final id = await db.saveReminder(file.id, title, at);
      if (at.isAfter(DateTime.now())) await _tryNotify(() => scheduler?.schedule(id, title, at));
    }
  }
}

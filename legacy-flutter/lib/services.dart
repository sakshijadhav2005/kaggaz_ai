import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/services.dart' show rootBundle;

import 'answer/answerer.dart';
import 'core/db.dart';
import 'core/ingest_service.dart';
import 'core/notification_scheduler.dart';
import 'interfaces.dart';
import 'core/vault.dart';
import 'extract/ocr_extractor.dart';
import 'extract/pdf_extractor.dart';
import 'index/indexer.dart';
import 'llm/gemini_api.dart';
import 'sort/gemma_classifier.dart';
import 'sort/rule_classifier.dart';
import 'sort/smart_sorter.dart';

Future<bool> isOnline() async {
  final r = await Connectivity().checkConnectivity();
  return !r.contains(ConnectivityResult.none);
}

late final Services services;

/// Composition root: the only place concrete classes are chosen.
class Services {
  Services._({required this.vault, required this.db, required this.ingest, required this.indexer, required this.answerer, required this.scheduler});

  final ReminderScheduler scheduler;
  final Vault vault;
  final Db db;
  final IngestService ingest;
  final Indexer indexer;
  final Answerer answerer;

  static Future<void> init() async {
    final scheduler = LocalReminderScheduler();
    try {
      await scheduler.init();
    } catch (_) {
      // Notifications are optional; the app works without them.
    }
    final vault = await Vault.open();
    final db = await Db.open();
    final llm = GemmaLlmClient();
    final embedder = GeminiEmbeddingProvider();
    final indexer = Indexer(db: db, embedder: embedder);
    final ocr = OcrExtractor(llm: llm, isOnline: isOnline);
    final sorter = SmartSorter(
      rules: RuleClassifier.fromJson(await rootBundle.loadString('assets/rules.json')),
      gemma: GemmaClassifier(llm),
      isOnline: isOnline,
    );
    services = Services._(
      vault: vault,
      db: db,
      indexer: indexer,
      answerer: Answerer(db: db, embedder: embedder, llm: llm),
      ingest: IngestService(
        vault: vault,
        db: db,
        extractors: [PdfExtractor(ocr), ocr],
        sorter: sorter,
        indexer: indexer,
        scheduler: scheduler,
      ),
      scheduler: scheduler,
    );
    // Catch up on chunks that were imported offline.
    indexer.embedMissing();
  }
}

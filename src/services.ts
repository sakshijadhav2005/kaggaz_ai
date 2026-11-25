import { Capacitor } from '@capacitor/core';

import { buildRegistry } from './agent/actions';
import type { BackupDeps } from './backup/backupService';
import type { ActionRegistry } from './agent/registry';
import { Answerer, buildGeneralPrompt } from './answer/answerer';
import { setConsentAudit } from './core/consent';
import { Db } from './core/db';
import { migrateToEncrypted } from './core/encryptionMigration';
import { loadCipher } from './core/keyStore';
import { IngestService } from './core/ingestService';
import { buildNamePrompt, heuristicName, parseSuggestedName } from './core/naming';
import { LocalReminderScheduler } from './core/scheduler';
import { summarizeStorage, type StorageDetails } from './core/storage';
import { CapacitorVault } from './core/vault';
import { AudioExtractor } from './extract/audioExtractor';
import { MlKitEngine } from './extract/mlkitEngine';
import { OcrExtractor } from './extract/ocrExtractor';
import { FallbackEngine } from './extract/ocrEngine';
import { PdfExtractor } from './extract/pdfExtractor';
import { TesseractEngine } from './extract/tesseractEngine';
import { Indexer } from './index/indexer';
import type { ReminderScheduler } from './interfaces';
import { GemmaLlmClient, GeminiEmbeddingProvider, GeminiTranscriber, hostedAllowed } from './llm/gemini';
import { OnDeviceLlmClient } from './llm/onDevice';
import { RoutedLlmClient } from './llm/router';
import { rasterize, textImage, toEmbeddable } from './pdf/browserImages';
import { PdfEngine, type WorkerLike } from './pdf/pdfEngine';
import PdfOpsWorker from './pdf/pdfOps.worker?worker';
import { PdfTools } from './pdf/pdfTools';
import { GemmaClassifier } from './sort/gemmaClassifier';
import { RuleClassifier, type RuleJson } from './sort/ruleClassifier';
import rules from './sort/rules.json';
import { SmartSorter } from './sort/smartSorter';

export const isOnline = () => navigator.onLine;

export interface Services {
  read: (f: { path: string; name: string }) => Promise<Blob>;
  storageDetails: () => Promise<StorageDetails>;
  /** Embeds chunks imported earlier without a key or connection. Safe to call often. */
  embedMissing: () => Promise<void>;
  /** General-knowledge reply for questions the user's files do not cover. */
  general: (question: string) => Promise<string>;
  /** Gemma 4 on the device: download, status. */
  local: OnDeviceLlmClient;
  /** Gemma 4: hosted when online, on the device otherwise. */
  llm: RoutedLlmClient;
  db: Db;
  ingest: IngestService;
  answerer: Answerer;
  scheduler: ReminderScheduler;
  /** Merge, split, compress and more. Results are saved as new documents. */
  pdf: PdfTools;
  /** Everything the assistant can do (src/agent). */
  actions: ActionRegistry;
  /** What backup and restore need (src/backup). */
  backup: BackupDeps;
}

let instance: Services | undefined;

export const services = (): Services => {
  if (!instance) throw new Error('Services not initialised');
  return instance;
};

/** Composition root: the only place concrete classes are chosen. */
export async function initServices(): Promise<Services> {
  // Everything stored is encrypted with one key held in the Android Keystore.
  const cipher = await loadCipher();
  const vault = new CapacitorVault(cipher);
  await vault.init();
  const db = new Db(cipher);
  await migrateToEncrypted(db, vault);
  // Every consent answer is written to the tamper-evident audit log.
  setConsentAudit((event, details) => db.appendAudit(event, details));
  const embedder = new GeminiEmbeddingProvider();
  const indexer = new Indexer(db, embedder);

  // One Gemma 4 for everything: hosted when online with a key, on the device otherwise.
  const local = new OnDeviceLlmClient();
  local.resumePending();
  const llm = new RoutedLlmClient(new GemmaLlmClient(), local, () => isOnline() && hostedAllowed());

  const scheduler = new LocalReminderScheduler();
  try {
    await scheduler.init();
  } catch {
    // Notifications are optional (not supported in a browser).
  }

  const read = (f: { path: string; name: string }) => vault.read(f.path, f.name);
  // ML Kit on a phone (fast, offline); Tesseract in a browser, and as the backup if ML Kit fails.
  const tesseract = new TesseractEngine();
  const engine = Capacitor.isNativePlatform() ? new FallbackEngine(new MlKitEngine(), tesseract) : tesseract;
  const ocr = new OcrExtractor(read, () => llm.available(), engine, llm);
  const sorter = new SmartSorter(new RuleClassifier(rules as RuleJson[]), () => llm.available(), new GemmaClassifier(llm));

  /** A file name from the document text: Gemma 4 if one is reachable, else the document's first title line. */
  const suggestName = async (text: string): Promise<string | null> => {
    if (llm.available()) {
      try {
        const name = parseSuggestedName(await llm.complete(buildNamePrompt(text)));
        if (name) return name;
      } catch {
        // Fall back to the heuristic.
      }
    }
    return heuristicName(text);
  };

  // Audio is transcribed online only (the on-device model takes no audio); offline it is sorted by name.
  const audio = new AudioExtractor(read, () => isOnline() && hostedAllowed(), new GeminiTranscriber());
  const ingest = new IngestService(vault, db, [new PdfExtractor(read, ocr), ocr, audio], sorter, indexer, scheduler, suggestName);
  const pdf = new PdfTools({
    getFile: (id) => db.getFile(id),
    read,
    importFile: (f) => ingest.importFile(f),
    moveManually: (f, folder) => ingest.moveManually(f, folder),
    engine: new PdfEngine(() => new PdfOpsWorker() as unknown as WorkerLike),
    rasterize,
    toEmbeddable,
    textImage,
  });
  instance = {
    read,
    storageDetails: async () => {
      const files = await db.allFilesIncludingTrash();
      const entries = await Promise.all(files.map(async (file) => ({ type: file.type, bytes: await vault.fileSize(file.path) })));
      return summarizeStorage(entries);
    },
    embedMissing: () => indexer.embedMissing(),
    general: (q) => llm.complete(buildGeneralPrompt(q)),
    local,
    llm,
    db,
    scheduler,
    answerer: new Answerer(db, embedder, llm),
    ingest,
    pdf,
    actions: buildRegistry({ db, ops: ingest, pdf }),
    backup: {
      db,
      readFile: read,
      storeFile: (data, f) => vault.store(data, f.name, f.id, f.folder),
      schedule: (id, title, at) => scheduler.schedule(id, title, at),
    },
  };
  // Catch up on chunks that were imported offline.
  void indexer.embedMissing();
  return instance;
}

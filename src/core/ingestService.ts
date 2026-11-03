import { detectLanguage } from '../extract/textUtils';
import { sanitizeStem, splitName } from './naming';
import type { Indexer } from '../index/indexer';
import type { Extractor, ReminderScheduler, VaultStore } from '../interfaces';
import {
  fileTypeFor,
  fullText,
  statusFor,
  type ExtractedSegment,
  type FileStatus,
  type Folder,
  type StoredFile,
} from '../models';
import { isEmptyRecord, parseRecord } from '../records/recordParser';
import type { SmartSorter } from '../sort/smartSorter';
import type { Db } from './db';

/** Wires the pipeline: import -> extract -> sort -> index -> records/reminders. */
export class IngestService {
  constructor(
    private vault: VaultStore,
    private db: Db,
    private extractors: Extractor[],
    private sorter: SmartSorter,
    private indexer: Indexer,
    private scheduler?: ReminderScheduler,
    /** Proposes a file name from the document's text (Gemma 4, online or on-device). */
    private suggest?: (text: string) => Promise<string | null>,
  ) {}

  /** [autoName] renames the file from its content once the text has been read. */
  async importFile(src: File, opts: { autoName?: boolean } = {}): Promise<StoredFile> {
    const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const path = await this.vault.store(src, src.name, id, 'Unsorted');
    const file: StoredFile = {
      id,
      name: src.name,
      type: fileTypeFor(src.name),
      path,
      folder: 'Unsorted',
      status: 'processing',
      source: 'rule',
      language: 'en',
      importedAt: Date.now(),
      text: '',
    };
    await this.db.insertFile(file);
    await this.process(file);
    if (opts.autoName) {
      const stem = await this.suggestStem(file);
      if (stem) await this.rename(file, stem);
    }
    return (await this.db.getFile(id))!;
  }

  /** A proposed name (without extension) based on the file's text, or null if there is none. */
  async suggestStem(file: StoredFile): Promise<string | null> {
    const text = (await this.fresh(file)).text;
    if (!this.suggest || text.trim() === '') return null;
    try {
      return await this.suggest(text);
    } catch {
      return null;
    }
  }

  /** Renames the file. The extension is kept, so the file type never changes. Returns the new name. */
  async rename(file: StoredFile, stem: string): Promise<string> {
    const current = await this.fresh(file);
    const clean = sanitizeStem(stem);
    if (clean === '') throw new Error('The name cannot be empty.');
    const name = `${clean}${splitName(current.name).ext}`;
    await this.db.updateFile(file.id, { name });
    return name;
  }

  /** Extract and finish. Also used by Retry. */
  async process(file: StoredFile): Promise<void> {
    file = await this.fresh(file);
    const extractor = this.extractors.find((e) => e.canHandle(file));
    let segments: ExtractedSegment[] = [];
    if (extractor) {
      try {
        segments = await extractor.extract(file);
      } catch (e) {
        // Leave empty; the file lands in needs_review and the user can retry or edit.
        console.error(`Could not read text from ${file.name}:`, e);
      }
    }
    await this.finish(file, segments, statusFor(segments));
  }

  /** User-edited text replaces the extraction. */
  async replaceText(file: StoredFile, text: string): Promise<void> {
    file = await this.fresh(file);
    const seg: ExtractedSegment = { text, language: detectLanguage(text), confidence: 1, method: 'manual' };
    await this.finish(file, [seg], 'ready');
  }

  /** Manual folders are never changed by a re-run. */
  async moveManually(file: StoredFile, folder: Folder): Promise<void> {
    const path = await this.vault.move(file.path, folder);
    await this.db.updateFile(file.id, { folder, path, source: 'manual' });
  }

  async toggleFavorite(file: StoredFile): Promise<void> {
    await this.db.setFavorite(file.id, !file.favorite);
  }

  /** Hides the file everywhere (folders, search, answers, expenses) and stops its reminder alert. */
  async moveToTrash(file: StoredFile): Promise<void> {
    await this.db.moveToTrash(file.id);
    const reminder = await this.db.reminderForFile(file.id);
    if (reminder?.id !== undefined) await this.tryNotify((s) => s.cancel(reminder.id!));
  }

  async restore(file: StoredFile): Promise<void> {
    await this.db.restore(file.id);
    const r = await this.db.reminderForFile(file.id);
    if (r?.id !== undefined && !r.done && r.dueAt > Date.now()) {
      await this.tryNotify((s) => s.schedule(r.id!, r.title, new Date(r.dueAt)));
    }
  }

  /** Permanent: removes the stored file, its text, search data, record and reminder. */
  async deleteForever(file: StoredFile): Promise<void> {
    const r = await this.db.reminderForFile(file.id);
    if (r?.id !== undefined) await this.tryNotify((s) => s.cancel(r.id!));
    try {
      await this.vault.remove(file.path);
    } catch {
      // Already gone; still clear the database rows.
    }
    await this.db.deleteForever(file.id);
  }

  async emptyTrash(): Promise<void> {
    for (const f of await this.db.trash()) await this.deleteForever(f);
  }

  /** Callers may hold an old copy (path or source changed since). */
  private async fresh(file: StoredFile) {
    return (await this.db.getFile(file.id)) ?? file;
  }

  private async finish(file: StoredFile, segments: ExtractedSegment[], status: FileStatus) {
    const text = fullText(segments);
    await this.db.updateFile(file.id, { text });
    await this.indexer.store(file.id, segments);

    let folder = file.folder;
    if (file.source !== 'manual') {
      const decision = await this.sorter.decide(file, text);
      const path = await this.vault.move(file.path, decision.folder);
      folder = decision.folder;
      await this.db.updateFile(file.id, { folder, path, source: decision.source });
    }

    await this.db.updateFile(file.id, { status, language: detectLanguage(text) });
    await this.extractRecord(file, folder, text);
    await this.indexer.embedMissing();
  }

  private async extractRecord(file: StoredFile, folder: Folder, text: string) {
    await this.db.deleteRecord(file.id);
    const oldId = await this.db.reminderIdForFile(file.id);
    if (oldId !== undefined) await this.tryNotify((s) => s.cancel(oldId));
    await this.db.deleteReminder(file.id);

    if (folder !== 'Bills' && folder !== 'Receipts') return;
    const r = parseRecord(text);
    if (isEmptyRecord(r)) return;
    await this.db.saveRecord({
      fileId: file.id,
      kind: folder === 'Bills' ? 'bill' : 'receipt',
      vendor: r.vendor,
      amount: r.amount,
      currency: 'INR',
      docDate: r.docDate?.getTime(),
      dueDate: r.dueDate?.getTime(),
    });
    if (r.dueDate) {
      const who = r.vendor ?? file.name;
      const amt = r.amount === undefined ? '' : ` (Rs ${r.amount.toFixed(2)})`;
      const title = `Pay ${who}${amt}`;
      const at = new Date(r.dueDate.getFullYear(), r.dueDate.getMonth(), r.dueDate.getDate(), 9);
      const id = await this.db.saveReminder(file.id, title, at.getTime());
      if (at.getTime() > Date.now()) await this.tryNotify((s) => s.schedule(id, title, at));
    }
  }

  /** A notification failure (permission denied, no platform support) must not fail an import. */
  private async tryNotify(action: (s: ReminderScheduler) => Promise<void>) {
    if (!this.scheduler) return;
    try {
      await action(this.scheduler);
    } catch {
      // Ignore.
    }
  }
}

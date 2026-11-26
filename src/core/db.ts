import Dexie, { type Table } from 'dexie';

import type { AnswerSource } from '../answer/answerer';
import type { Chunk, Folder, RecordRow, Reminder, StoredFile } from '../models';
import type { SearchableChunk } from '../search/snippets';
import { base64ToBytes, bytesToBase64, isEncryptedString, type FieldCipher } from './crypto';

/*
 * What is encrypted (AES-GCM, see crypto.ts):
 * - files: name, text
 * - chunks: text, embedding
 * - records: everything except fileId
 * - reminders: title
 * Indexed and filter fields (ids, folder, dates, status, favorite, deletedAt) stay plain so queries work.
 * Encryption happens outside Dexie transactions: awaiting Web Crypto inside one would commit it early.
 */

/** As stored: the embedding is encrypted Float32 bytes in base64 (or a plain array in legacy rows). */
type ChunkRow = Omit<Chunk, 'embedding'> & { embedding?: string | number[] };
/** As stored: `enc` holds the encrypted record. Legacy rows have the plain fields instead. */
type RecordStoreRow = { fileId: string; enc?: string } & Partial<RecordRow>;

/**
 * Append-only record of consent and other events that may need proving later. Each row's hash covers the
 * previous row's hash, so editing or deleting an old row breaks the chain (see verifyAudit). Rows hold
 * no document data, so they are not encrypted: anyone checking the log can read it.
 */
export interface AuditRow {
  id?: number;
  at: number;
  event: string;
  /** JSON. */
  details: string;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const auditHash = (r: Omit<AuditRow, 'id' | 'hash'>) => sha256Hex(`${r.prevHash}|${r.at}|${r.event}|${r.details}`);

class KaagazDexie extends Dexie {
  files!: Table<StoredFile, string>;
  chunks!: Table<ChunkRow, number>;
  records!: Table<RecordStoreRow, string>;
  reminders!: Table<Reminder, number>;
  audit!: Table<AuditRow, number>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      files: 'id, folder, importedAt',
      chunks: '++id, fileId',
      records: 'fileId',
      reminders: '++id, fileId, dueAt',
    });
    this.version(2).stores({ audit: '++id' });
  }
}

export class Db implements AnswerSource {
  private d: KaagazDexie;

  constructor(
    private cipher: FieldCipher,
    name = 'kaagaz',
  ) {
    this.d = new KaagazDexie(name);
  }

  // Encoding

  private async encFile<T extends Partial<StoredFile>>(f: T): Promise<T> {
    const out = { ...f };
    if (f.name !== undefined) out.name = await this.cipher.encryptString(f.name);
    if (f.text !== undefined) out.text = await this.cipher.encryptString(f.text);
    return out;
  }

  private decFile = async (f: StoredFile): Promise<StoredFile> => ({
    ...f,
    name: await this.cipher.decryptString(f.name),
    text: await this.cipher.decryptString(f.text),
  });

  private decFiles = (rows: StoredFile[]) => Promise.all(rows.map(this.decFile));

  private async encEmbedding(v: number[]): Promise<string> {
    const bytes = new Uint8Array(new Float32Array(v).buffer);
    return bytesToBase64(await this.cipher.encryptBytes(bytes));
  }

  private async decEmbedding(v: string | number[] | undefined): Promise<number[] | undefined> {
    if (v === undefined || Array.isArray(v)) return v;
    const bytes = await this.cipher.decryptBytes(base64ToBytes(v));
    return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
  }

  private async encChunk(c: Chunk): Promise<ChunkRow> {
    return {
      ...c,
      text: await this.cipher.encryptString(c.text),
      embedding: c.embedding ? await this.encEmbedding(c.embedding) : undefined,
    };
  }

  private decChunk = async (c: ChunkRow): Promise<Chunk> => ({
    ...c,
    text: await this.cipher.decryptString(c.text),
    embedding: await this.decEmbedding(c.embedding),
  });

  private decChunks = (rows: ChunkRow[]) => Promise.all(rows.map(this.decChunk));

  private async decRecord(r: RecordStoreRow): Promise<RecordRow> {
    if (r.enc) return { ...(await this.cipher.decryptJson<Omit<RecordRow, 'fileId'>>(r.enc)), fileId: r.fileId };
    const { enc: _e, ...legacy } = r;
    return legacy as RecordRow;
  }

  private decReminder = async (r: Reminder): Promise<Reminder> => ({ ...r, title: await this.cipher.decryptString(r.title) });

  // Files

  insertFile = async (f: StoredFile) => this.d.files.add(await this.encFile(f));
  updateFile = async (id: string, values: Partial<StoredFile>) => this.d.files.update(id, await this.encFile(values));

  async getFile(id: string): Promise<StoredFile | undefined> {
    const f = await this.d.files.get(id);
    return f && this.decFile(f);
  }

  /** Files in Trash are hidden here, and so from folders, search, answers, expenses and reminders. */
  async files(folder?: Folder): Promise<StoredFile[]> {
    const all = folder ? await this.d.files.where('folder').equals(folder).toArray() : await this.d.files.toArray();
    return this.decFiles(all.filter((f) => !f.deletedAt).sort((a, b) => b.importedAt - a.importedAt));
  }

  async favorites(): Promise<StoredFile[]> {
    return (await this.files()).filter((f) => f.favorite);
  }

  async trash(): Promise<StoredFile[]> {
    const rows = (await this.d.files.toArray()).filter((f) => f.deletedAt).sort((a, b) => b.deletedAt! - a.deletedAt!);
    return this.decFiles(rows);
  }

  async folderCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    await this.d.files.each((f) => {
      if (!f.deletedAt) counts[f.folder] = (counts[f.folder] ?? 0) + 1;
    });
    return counts;
  }

  async specialCounts(): Promise<{ favorites: number; trash: number }> {
    let favorites = 0, trash = 0;
    await this.d.files.each((f) => {
      if (f.deletedAt) trash++;
      else if (f.favorite) favorites++;
    });
    return { favorites, trash };
  }

  setFavorite = (id: string, favorite: boolean) => this.d.files.update(id, { favorite });
  setLocked = (id: string, locked: boolean) => this.d.files.update(id, { locked });
  moveToTrash = (id: string) => this.d.files.update(id, { deletedAt: Date.now() });
  restore = (id: string) => this.d.files.update(id, { deletedAt: undefined });

  /** Removes the file's row and everything derived from it. The caller deletes the stored file. */
  deleteForever(id: string) {
    return this.d.transaction('rw', [this.d.files, this.d.chunks, this.d.records, this.d.reminders], async () => {
      await this.d.chunks.where('fileId').equals(id).delete();
      await this.d.records.delete(id);
      await this.d.reminders.where('fileId').equals(id).delete();
      await this.d.files.delete(id);
    });
  }

  private async trashedIds(): Promise<Set<string>> {
    return new Set((await this.d.files.filter((f) => !!f.deletedAt).primaryKeys()) as string[]);
  }

  /** Files whose text must not be read for answers or sent anywhere: in Trash, or locked. */
  private async privateIds(): Promise<Set<string>> {
    return new Set((await this.d.files.filter((f) => !!f.deletedAt || !!f.locked).primaryKeys()) as string[]);
  }

  /** Files whose name or chunks contain every token. Locked files match by name only. */
  async keywordSearch(tokens: string[]): Promise<StoredFile[]> {
    if (tokens.length === 0) return [];
    const hidden = await this.privateIds();
    const byFile = new Map<string, string>();
    for (const c of await this.decChunks((await this.d.chunks.toArray()).filter((c) => !hidden.has(c.fileId)))) {
      byFile.set(c.fileId, (byFile.get(c.fileId) ?? '') + ' ' + c.text.toLowerCase());
    }
    return (await this.files()).filter((f) => {
      const hay = f.name.toLowerCase() + ' ' + (byFile.get(f.id) ?? '');
      return tokens.every((t) => hay.includes(t));
    });
  }

  // Chunks

  /** Every chunk with its file's name and folder, for offline content search. Locked files are left out. */
  async searchableChunks(): Promise<SearchableChunk[]> {
    const byId = new Map((await this.files()).filter((f) => !f.locked).map((f) => [f.id, f]));
    const rows = (await this.d.chunks.toArray()).filter((c) => byId.has(c.fileId));
    return (await this.decChunks(rows)).map((c) => {
      const f = byId.get(c.fileId)!;
      return { fileId: f.id, fileName: f.name, folder: f.folder, page: c.page, text: c.text };
    });
  }

  /** The page number stored on a file's first chunk (page is not encrypted, so nothing is decrypted). */
  async firstChunkPage(fileId: string): Promise<number | undefined> {
    return (await this.d.chunks.where('fileId').equals(fileId).first())?.page;
  }

  /** A file's chunks in stored order, decrypted. */
  async chunksForFile(fileId: string): Promise<Chunk[]> {
    return this.decChunks(await this.d.chunks.where('fileId').equals(fileId).toArray());
  }

  async replaceChunks(fileId: string, chunks: Chunk[]) {
    const rows = await Promise.all(chunks.map(({ id: _id, ...c }) => this.encChunk(c)));
    return this.d.transaction('rw', this.d.chunks, async () => {
      await this.d.chunks.where('fileId').equals(fileId).delete();
      await this.d.chunks.bulkAdd(rows);
    });
  }

  /** Chunks still to embed. Locked and trashed files are never embedded: that would send their text out. */
  async chunksMissingEmbedding(limit = 50): Promise<Chunk[]> {
    const hidden = await this.privateIds();
    return this.decChunks(await this.d.chunks.filter((c) => !c.embedding && !hidden.has(c.fileId)).limit(limit).toArray());
  }
  setChunkEmbedding = async (id: number, embedding: number[]) => this.d.chunks.update(id, { embedding: await this.encEmbedding(embedding) });

  async chunksWithEmbeddings(): Promise<Chunk[]> {
    const hidden = await this.privateIds();
    return this.decChunks(await this.d.chunks.filter((c) => !!c.embedding && !hidden.has(c.fileId)).toArray());
  }

  // Records and reminders

  saveRecord = async ({ fileId, ...rest }: RecordRow) => this.d.records.put({ fileId, enc: await this.cipher.encryptJson(rest) });
  deleteRecord = (fileId: string) => this.d.records.delete(fileId);

  /** Bills and receipts with their file names, newest first. */
  async records(): Promise<(RecordRow & { fileName: string })[]> {
    const rows = await this.d.records.toArray();
    const out = [];
    for (const row of rows) {
      const f = await this.getFile(row.fileId);
      if (!f || f.deletedAt) continue;
      const r = await this.decRecord(row);
      out.push({ ...r, fileName: f.name, sortKey: r.docDate ?? f.importedAt });
    }
    return out.sort((a, b) => b.sortKey - a.sortKey).map(({ sortKey: _k, ...r }) => r);
  }

  /** The file's reminder, including while the file is in Trash (so it can be re-armed on restore). */
  async reminderForFile(fileId: string): Promise<Reminder | undefined> {
    const r = await this.d.reminders.where('fileId').equals(fileId).first();
    return r && this.decReminder(r);
  }

  async reminderIdForFile(fileId: string): Promise<number | undefined> {
    return (await this.d.reminders.where('fileId').equals(fileId).first())?.id;
  }

  async saveReminder(fileId: string, title: string, dueAt: number): Promise<number> {
    const enc = await this.cipher.encryptString(title);
    await this.deleteReminder(fileId);
    return this.d.reminders.add({ fileId, title: enc, dueAt, done: false });
  }

  deleteReminder = (fileId: string) => this.d.reminders.where('fileId').equals(fileId).delete();

  async reminders(): Promise<Reminder[]> {
    const gone = await this.trashedIds();
    const rows = (await this.d.reminders.filter((r) => !gone.has(r.fileId)).toArray()).sort(
      (a, b) => Number(a.done) - Number(b.done) || a.dueAt - b.dueAt,
    );
    return Promise.all(rows.map(this.decReminder));
  }

  setReminderDone = (id: number, done: boolean) => this.d.reminders.update(id, { done });

  // Audit log

  /** Appends run one at a time so two never claim the same previous row. */
  private auditQueue: Promise<unknown> = Promise.resolve();

  appendAudit(event: string, details: Record<string, unknown>): Promise<void> {
    const run = this.auditQueue.then(async () => {
      const last = await this.d.audit.orderBy('id').last();
      const row = { at: Date.now(), event, details: JSON.stringify(details), prevHash: last?.hash ?? GENESIS };
      await this.d.audit.add({ ...row, hash: await auditHash(row) });
    });
    this.auditQueue = run.catch(() => {});
    return run;
  }

  /** Newest first. */
  async auditLog(limit = 50): Promise<AuditRow[]> {
    return this.d.audit.orderBy('id').reverse().limit(limit).toArray();
  }

  /**
   * Re-checks every hash. `brokenAt` is the id of the first row that was changed, or follows a removed one.
   * Removing the newest rows cannot be detected from the log alone (nothing outside it records the last hash).
   */
  async verifyAudit(): Promise<{ ok: boolean; rows: number; brokenAt?: number }> {
    const rows = await this.d.audit.orderBy('id').toArray();
    let prev = GENESIS;
    for (const r of rows) {
      if (r.prevHash !== prev || (await auditHash(r)) !== r.hash) return { ok: false, rows: rows.length, brokenAt: r.id };
      prev = r.hash;
    }
    return { ok: true, rows: rows.length };
  }

  // Backup

  /** Everything needed to rebuild the library elsewhere, decrypted. Embeddings are left out: they are rebuilt. */
  async exportRows(): Promise<{ files: StoredFile[]; chunks: Chunk[]; records: RecordRow[]; reminders: Reminder[] }> {
    const chunks = (await this.decChunks(await this.d.chunks.toArray())).map(({ id: _id, embedding: _e, ...c }) => c);
    const records = await Promise.all((await this.d.records.toArray()).map((r) => this.decRecord(r)));
    const reminders = (await Promise.all((await this.d.reminders.toArray()).map(this.decReminder))).map(({ id: _id, ...r }) => r);
    return { files: await this.decFiles(await this.d.files.toArray()), chunks, records, reminders };
  }

  hasFile = async (id: string) => (await this.d.files.get(id)) !== undefined;

  /** A reminder as it was, done flag included. Returns its new id. */
  async importReminder(r: Omit<Reminder, 'id'>): Promise<number> {
    return this.d.reminders.add({ ...r, title: await this.cipher.encryptString(r.title) });
  }

  // Migration

  /** Every file row including Trash, decrypted. Used by the one-time vault migration. */
  async allFilesIncludingTrash(): Promise<StoredFile[]> {
    return this.decFiles(await this.d.files.toArray());
  }

  /** Encrypts rows written before encryption existed. Safe to run repeatedly; returns how many rows changed. */
  async encryptLegacyRows(): Promise<number> {
    let changed = 0;

    for (const f of await this.d.files.toArray()) {
      const patch: Partial<StoredFile> = {};
      if (!isEncryptedString(f.name)) patch.name = f.name;
      if (!isEncryptedString(f.text)) patch.text = f.text;
      if (Object.keys(patch).length) {
        await this.d.files.update(f.id, await this.encFile(patch));
        changed++;
      }
    }

    for (const c of await this.d.chunks.toArray()) {
      const patch: Partial<ChunkRow> = {};
      if (!isEncryptedString(c.text)) patch.text = await this.cipher.encryptString(c.text);
      if (Array.isArray(c.embedding)) patch.embedding = await this.encEmbedding(c.embedding);
      if (Object.keys(patch).length) {
        await this.d.chunks.update(c.id!, patch);
        changed++;
      }
    }

    for (const r of await this.d.records.toArray()) {
      if (r.enc) continue;
      await this.saveRecord(await this.decRecord(r));
      changed++;
    }

    for (const r of await this.d.reminders.toArray()) {
      if (isEncryptedString(r.title)) continue;
      await this.d.reminders.update(r.id!, { title: await this.cipher.encryptString(r.title) });
      changed++;
    }
    return changed;
  }
}

import type { Db } from '../core/db';
import { strings } from '../i18n';
import type { Chunk, RecordRow, Reminder, StoredFile } from '../models';
import { BackupError, BackupWriter, DEFAULT_ITERATIONS, readBackup, type ByteSource } from './backupFormat';

/*
 * Backup and restore of the whole library: documents (including Trash), their text, search passages,
 * bills and reminders. Not included: embeddings (rebuilt when online AI is on), settings, the app lock,
 * consent answers and the audit log, which belong to the phone and the person using it.
 *
 * Restore only ADDS documents whose id is not already on this phone. It never deletes or overwrites.
 */

export interface BackupData {
  version: 1;
  createdAt: string;
  files: StoredFile[];
  chunks: Omit<Chunk, 'id'>[];
  records: RecordRow[];
  reminders: Omit<Reminder, 'id'>[];
}

export interface BackupDeps {
  db: Pick<Db, 'exportRows' | 'hasFile' | 'insertFile' | 'replaceChunks' | 'saveRecord' | 'importReminder'>;
  readFile(f: StoredFile): Promise<Blob>;
  /** Stores the bytes in the vault and returns the path. */
  storeFile(data: Blob, f: StoredFile): Promise<string>;
  /** Re-arms a reminder's notification on this phone. */
  schedule?(id: number, title: string, at: Date): Promise<void>;
}

export type Progress = (done: number, total: number) => void;

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Writes a backup through [write], piece by piece. Returns how many documents it holds. */
export async function createBackup(
  d: BackupDeps,
  password: string,
  write: (bytes: Uint8Array) => Promise<void>,
  onProgress?: Progress,
  iterations = DEFAULT_ITERATIONS,
): Promise<number> {
  const w = await BackupWriter.create(password, iterations);
  await write(w.header);
  const rows = await d.db.exportRows();
  const data: BackupData = { version: 1, createdAt: new Date().toISOString(), ...rows };
  for await (const b of w.parts({ t: 'data', name: 'library' }, utf8(JSON.stringify(data)))) await write(b);

  let done = 0;
  onProgress?.(0, rows.files.length);
  for (const f of rows.files) {
    const bytes = new Uint8Array(await (await d.readFile(f)).arrayBuffer());
    for await (const b of w.parts({ t: 'file', id: f.id }, bytes)) await write(b);
    onProgress?.(++done, rows.files.length);
  }
  await write(await w.end());
  return rows.files.length;
}

export interface RestoreResult {
  added: number;
  /** Already on this phone (same id), left as they are. */
  skipped: number;
}

/**
 * Reads a backup and adds what is missing. Every record is authenticated before it is used, so nothing
 * from a changed file is ever applied. If the file is cut short, the documents read so far stay and the
 * error says how many.
 */
export async function restoreBackup(d: BackupDeps, src: ByteSource, password: string, onProgress?: Progress): Promise<RestoreResult> {
  let data: BackupData | null = null;
  const dataParts: Uint8Array[] = [];
  let current: { id: string; parts: Uint8Array[] } | null = null;
  const result: RestoreResult = { added: 0, skipped: 0 };

  try {
    for await (const { meta, payload } of readBackup(src, password)) {
      if (meta.t === 'data') {
        dataParts.push(payload.slice());
        if (meta.last) {
          data = JSON.parse(new TextDecoder().decode(await new Blob(dataParts as Uint8Array<ArrayBuffer>[]).arrayBuffer())) as BackupData;
          if (data.version !== 1) throw new BackupError(strings().backupErrors.newer);
          onProgress?.(0, data.files.length);
        }
        continue;
      }
      if (meta.t !== 'file') continue;
      if (!data) throw new BackupError(strings().backupErrors.damaged);
      if (meta.part === 0) current = { id: meta.id, parts: [] };
      if (!current || current.id !== meta.id || current.parts.length !== meta.part) throw new BackupError(strings().backupErrors.damaged);
      current.parts.push(payload.slice());
      if (!meta.last) continue;

      const file = data.files.find((f) => f.id === meta.id);
      if (file) {
        if (await d.db.hasFile(file.id)) result.skipped++;
        else {
          await addOne(d, data, file, new Blob(current.parts as Uint8Array<ArrayBuffer>[]));
          result.added++;
        }
      }
      current = null;
      onProgress?.(result.added + result.skipped, data.files.length);
    }
  } catch (e) {
    if (result.added > 0 && e instanceof BackupError) {
      throw new BackupError(`${e.message} ${strings().backupErrors.partly(result.added)}`);
    }
    throw e;
  }
  if (!data) throw new BackupError(strings().backupErrors.damaged);
  return result;
}

async function addOne(d: BackupDeps, data: BackupData, file: StoredFile, bytes: Blob) {
  // Stored first: a row must never point at a file that is not there.
  const path = await d.storeFile(bytes, file);
  await d.db.insertFile({ ...file, path });
  await d.db.replaceChunks(file.id, data.chunks.filter((c) => c.fileId === file.id));
  const record = data.records.find((r) => r.fileId === file.id);
  if (record) await d.db.saveRecord(record);
  for (const r of data.reminders.filter((x) => x.fileId === file.id)) {
    const id = await d.db.importReminder(r);
    if (!r.done && r.dueAt > Date.now() && !file.deletedAt) {
      try {
        await d.schedule?.(id, r.title, new Date(r.dueAt));
      } catch {
        // Notifications are optional.
      }
    }
  }
}

import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { BackupError, BackupWriter, HEADER_BYTES, PART_BYTES, readBackup, type ByteSource } from '../src/backup/backupFormat';
import { createBackup, restoreBackup, type BackupDeps } from '../src/backup/backupService';
import { FieldCipher } from '../src/core/crypto';
import { Db } from '../src/core/db';
import type { StoredFile } from '../src/models';

const ITER = 100_000; // the minimum the reader accepts; keeps tests fast
const PASSWORD = 'correct horse battery';
const cipher = await FieldCipher.fromRawKey(FieldCipher.generateRawKey());

const file = (id: string, over: Partial<StoredFile> = {}): StoredFile => ({
  id, name: `Doc ${id}.pdf`, type: 'pdf', path: `vault/Bills/${id}.kgz`, folder: 'Bills', status: 'ready', source: 'rule',
  language: 'en', importedAt: 1, text: `Secret text of ${id}: account 998877`, ...over,
});

/** A phone: its own database and vault. */
function phone() {
  const db = new Db(cipher, `backup-${Math.random()}`);
  const vault = new Map<string, Blob>();
  const scheduled: number[] = [];
  const deps: BackupDeps = {
    db,
    readFile: async (f) => vault.get(f.path)!,
    storeFile: async (data, f) => {
      const path = `vault/${f.folder}/${f.id}.kgz`;
      vault.set(path, data);
      return path;
    },
    schedule: async (id) => void scheduled.push(id),
  };
  return { db, vault, deps, scheduled };
}

async function seed(p: ReturnType<typeof phone>) {
  const bytes: Record<string, Uint8Array> = { a: new Uint8Array([1, 2, 3]), b: new Uint8Array([4, 5]), t: new Uint8Array([6]) };
  for (const [id, b] of Object.entries(bytes)) {
    const f = file(id, id === 't' ? { deletedAt: 9, folder: 'Other', path: 'vault/Other/t.kgz' } : {});
    p.vault.set(f.path, new Blob([b as Uint8Array<ArrayBuffer>]));
    await p.db.insertFile(f);
  }
  await p.db.replaceChunks('a', [{ fileId: 'a', text: 'chunk of a', page: 2, language: 'en', embedding: [0.1] }]);
  await p.db.saveRecord({ fileId: 'a', kind: 'bill', vendor: 'BSES', amount: 99, currency: 'INR', dueDate: 5 });
  await p.db.saveReminder('a', 'Pay BSES', Date.now() + 86_400_000);
  const old = await p.db.saveReminder('b', 'Old one', Date.now() - 1000);
  await p.db.setReminderDone(old, true);
  return bytes;
}

async function backupBytes(deps: BackupDeps, password = PASSWORD): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  await createBackup(deps, password, async (b) => void parts.push(b.slice()), undefined, ITER);
  return new Uint8Array(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}

const digest = async (b: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>)).toString('hex');

const source = (b: Uint8Array): ByteSource => ({ size: b.length, read: async (o, l) => b.slice(o, o + l) as Uint8Array<ArrayBuffer> });

describe('backup and restore', () => {
  it('restores everything onto a new phone', async () => {
    const old = phone();
    const bytes = await seed(old);
    const backup = await backupBytes(old.deps);

    const fresh = phone();
    const progress: string[] = [];
    const r = await restoreBackup(fresh.deps, source(backup), PASSWORD, (d, t) => progress.push(`${d}/${t}`));
    expect(r).toEqual({ added: 3, skipped: 0 });
    expect(progress.at(-1)).toBe('3/3');

    const a = (await fresh.db.getFile('a'))!;
    expect(a.text).toBe('Secret text of a: account 998877');
    expect(new Uint8Array(await fresh.vault.get(a.path)!.arrayBuffer())).toEqual(bytes.a);
    expect((await fresh.db.trash()).map((f) => f.id)).toEqual(['t']);
    expect((await fresh.db.searchableChunks())[0]).toMatchObject({ text: 'chunk of a', page: 2 });
    expect(await fresh.db.chunksWithEmbeddings()).toEqual([]); // rebuilt later, not copied
    expect((await fresh.db.records())[0]).toMatchObject({ vendor: 'BSES', amount: 99 });
    const reminders = await fresh.db.reminders();
    expect(reminders.map((x) => [x.title, x.done])).toEqual([['Pay BSES', false], ['Old one', true]]);
    // Only the future, open reminder gets a notification again.
    expect(fresh.scheduled).toHaveLength(1);
  });

  it('never overwrites: documents already on the phone are skipped', async () => {
    const old = phone();
    await seed(old);
    const backup = await backupBytes(old.deps);
    await old.db.updateFile('a', { name: 'Renamed since.pdf' });
    expect(await restoreBackup(old.deps, source(backup), PASSWORD)).toEqual({ added: 0, skipped: 3 });
    expect((await old.db.getFile('a'))?.name).toBe('Renamed since.pdf');
  });

  it('holds no readable document text', async () => {
    const old = phone();
    await seed(old);
    const text = new TextDecoder('latin1').decode(await backupBytes(old.deps));
    for (const s of ['Secret text', '998877', 'BSES', 'Pay ', 'Doc a']) expect(text).not.toContain(s);
  });

  it('rejects a wrong password, a short one, and files that are not backups', async () => {
    const old = phone();
    await seed(old);
    const backup = await backupBytes(old.deps);
    await expect(restoreBackup(phone().deps, source(backup), 'wrong password')).rejects.toThrow(/Wrong password/);
    await expect(BackupWriter.create('short')).rejects.toThrow(/at least 8/);
    await expect(restoreBackup(phone().deps, source(new TextEncoder().encode('%PDF-1.7 hello world, not a backup')), PASSWORD)).rejects.toThrow(/not a Kaagaz backup/);
  });

  it('detects a changed byte, swapped records and a file cut short', async () => {
    const old = phone();
    await seed(old);
    const backup = await backupBytes(old.deps);

    const flipped = backup.slice();
    flipped[flipped.length - 40] ^= 1;
    await expect(restoreBackup(phone().deps, source(flipped), PASSWORD)).rejects.toThrow(BackupError);

    // Swap the second and third records (each: 4-byte length + body).
    const recs: Uint8Array[] = [];
    for (let at = HEADER_BYTES; at < backup.length; ) {
      const len = new DataView(backup.buffer).getUint32(at);
      recs.push(backup.slice(at, at + 4 + len));
      at += 4 + len;
    }
    const swapped = new Uint8Array(await new Blob([backup.slice(0, HEADER_BYTES), recs[0], recs[2], recs[1], ...recs.slice(3)] as Uint8Array<ArrayBuffer>[]).arrayBuffer());
    await expect(restoreBackup(phone().deps, source(swapped), PASSWORD)).rejects.toThrow(/changed or damaged/);

    // Drop the end record: the documents read so far stay, and the error says so.
    const cut = backup.slice(0, backup.length - recs.at(-1)!.length);
    const target = phone();
    await expect(restoreBackup(target.deps, source(cut), PASSWORD)).rejects.toThrow(/incomplete.*3 documents were restored/);
    expect(await target.db.hasFile('a')).toBe(true);
  });

  it('splits big files across records and joins them again', async () => {
    const old = phone();
    const big = new Uint8Array(PART_BYTES * 2 + 123).map((_, i) => i % 251);
    await old.db.insertFile(file('big'));
    old.vault.set('vault/Bills/big.kgz', new Blob([big]));
    const backup = await backupBytes(old.deps);

    let fileRecords = 0;
    for await (const r of readBackup(source(backup), PASSWORD)) if (r.meta.t === 'file') fileRecords++;
    expect(fileRecords).toBe(3);
    expect(backup.length).toBeGreaterThan(big.length);

    const fresh = phone();
    await restoreBackup(fresh.deps, source(backup), PASSWORD);
    const back = new Uint8Array(await fresh.vault.get('vault/Bills/big.kgz')!.arrayBuffer());
    // Compared by length and digest: a failing toEqual on 8 MB would try to print the whole array.
    expect(back.length).toBe(big.length);
    expect(await digest(back)).toBe(await digest(big));
  });
});

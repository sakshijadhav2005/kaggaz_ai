import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import { FieldCipher, isEncryptedBytes, isEncryptedString } from '../src/core/crypto';
import { Db } from '../src/core/db';
import type { StoredFile } from '../src/models';

const newCipher = () => FieldCipher.fromRawKey(FieldCipher.generateRawKey());

const file = (id: string, over: Partial<StoredFile> = {}): StoredFile => ({
  id,
  name: 'Aadhaar card.pdf',
  type: 'pdf',
  path: `vault/Aadhaar/${id}.kgz`,
  folder: 'Aadhaar',
  status: 'ready',
  source: 'rule',
  language: 'en',
  importedAt: 1,
  text: 'Government of India 1234 5678 9012',
  ...over,
});

/** Opens the same IndexedDB without the Db class, to see what is actually on disk. */
async function raw(name: string) {
  const d = new Dexie(name);
  d.version(1).stores({ files: 'id, folder, importedAt', chunks: '++id, fileId', records: 'fileId', reminders: '++id, fileId, dueAt' });
  await d.open();
  return d;
}

describe('FieldCipher', () => {
  it('round-trips strings, bytes and JSON', async () => {
    const c = await newCipher();
    const s = await c.encryptString('PAN ABCDE1234F, नाम');
    expect(isEncryptedString(s)).toBe(true);
    expect(s).not.toContain('ABCDE1234F');
    expect(await c.decryptString(s)).toBe('PAN ABCDE1234F, नाम');

    const bytes = new Uint8Array([1, 2, 3, 250]);
    const enc = await c.encryptBytes(bytes);
    expect(isEncryptedBytes(enc)).toBe(true);
    expect(Array.from(await c.decryptBytes(enc))).toEqual([1, 2, 3, 250]);

    expect(await c.decryptJson(await c.encryptJson({ amount: 499.5 }))).toEqual({ amount: 499.5 });
  });

  it('uses a fresh IV each time', async () => {
    const c = await newCipher();
    expect(await c.encryptString('same')).not.toBe(await c.encryptString('same'));
  });

  it('passes legacy plaintext through unchanged', async () => {
    const c = await newCipher();
    expect(await c.decryptString('old plain name.pdf')).toBe('old plain name.pdf');
    const plainPdf = new TextEncoder().encode('%PDF-1.7 ...');
    expect(await c.decryptBytes(plainPdf)).toBe(plainPdf);
  });

  it('rejects a wrong key and tampered data', async () => {
    const a = await newCipher();
    const b = await newCipher();
    const s = await a.encryptString('secret');
    await expect(b.decryptString(s)).rejects.toThrow();

    const bytes = await a.encryptBytes(new Uint8Array([9, 9, 9]));
    bytes[bytes.length - 1] ^= 1;
    await expect(a.decryptBytes(bytes)).rejects.toThrow();
  });
});

describe('Db encryption at rest', () => {
  it('stores names, text, chunks, embeddings, records and reminders encrypted', async () => {
    const name = `enc-${Math.random()}`;
    const db = new Db(await newCipher(), name);
    await db.insertFile(file('f1'));
    await db.replaceChunks('f1', [{ fileId: 'f1', text: 'Government of India 1234', page: 1, language: 'en', embedding: [0.5, -1] }]);
    await db.saveRecord({ fileId: 'f1', kind: 'bill', vendor: 'BSES', amount: 1200, currency: 'INR', dueDate: 5 });
    await db.saveReminder('f1', 'Pay BSES', 10);

    const d = await raw(name);
    const dump = JSON.stringify([await d.table('files').toArray(), await d.table('chunks').toArray(), await d.table('records').toArray(), await d.table('reminders').toArray()]);
    for (const secret of ['Aadhaar card', '1234', 'BSES', '1200', 'Pay ']) expect(dump).not.toContain(secret);
    // Fields used by queries stay plain.
    expect(dump).toContain('"folder":"Aadhaar"');
    d.close();

    // And the Db class reads it all back.
    expect((await db.getFile('f1'))?.name).toBe('Aadhaar card.pdf');
    expect((await db.files('Aadhaar'))[0].text).toContain('1234 5678');
    expect((await db.keywordSearch(['government']))[0]?.id).toBe('f1');
    const [chunk] = await db.chunksWithEmbeddings();
    expect(chunk.text).toBe('Government of India 1234');
    expect(chunk.embedding).toEqual([0.5, -1]);
    expect((await db.records())[0]).toMatchObject({ vendor: 'BSES', amount: 1200, fileName: 'Aadhaar card.pdf' });
    expect((await db.reminders())[0].title).toBe('Pay BSES');
  });

  it('encrypts rows written before encryption, once', async () => {
    const name = `legacy-${Math.random()}`;
    const d = await raw(name);
    await d.table('files').add(file('old'));
    await d.table('chunks').add({ fileId: 'old', text: 'plain chunk 1234', language: 'en', embedding: [1, 0] });
    await d.table('records').put({ fileId: 'old', kind: 'receipt', vendor: 'Kirana', amount: 80, currency: 'INR' });
    await d.table('reminders').add({ fileId: 'old', title: 'Plain title', dueAt: 1, done: false });

    const db = new Db(await newCipher(), name);
    // Legacy rows read correctly before migration...
    expect((await db.getFile('old'))?.name).toBe('Aadhaar card.pdf');
    expect(await db.encryptLegacyRows()).toBe(4);
    expect(await db.encryptLegacyRows()).toBe(0);

    const dump = JSON.stringify([await d.table('files').toArray(), await d.table('chunks').toArray(), await d.table('records').toArray(), await d.table('reminders').toArray()]);
    for (const secret of ['Aadhaar card', '1234', 'Kirana', 'Plain title']) expect(dump).not.toContain(secret);
    d.close();

    // ...and after.
    expect((await db.getFile('old'))?.text).toContain('1234 5678');
    expect((await db.chunksWithEmbeddings())[0].embedding).toEqual([1, 0]);
    expect((await db.records())[0]).toMatchObject({ vendor: 'Kirana', amount: 80 });
    expect((await db.reminders())[0].title).toBe('Plain title');
  });
});

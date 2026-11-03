import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildRegistry, type ActionDeps } from '../src/agent/actions';
import type { ActionContext } from '../src/agent/registry';
import { FieldCipher } from '../src/core/crypto';
import { Db } from '../src/core/db';
import type { StoredFile } from '../src/models';
import { PdfTools } from '../src/pdf/pdfTools';

const cipher = await FieldCipher.fromRawKey(FieldCipher.generateRawKey());
const ctx: ActionContext = { openFile: () => {}, openTab: () => {} };

const file = (id: string, over: Partial<StoredFile> = {}): StoredFile => ({
  id, name: `Doc ${id}.pdf`, type: 'pdf', path: id, folder: 'Medical', status: 'ready', source: 'rule', language: 'en',
  importedAt: Number(id), text: `report ${id}`, ...over,
});

let db: Db;

beforeEach(async () => {
  db = new Db(cipher, `lock-${Math.random()}`);
  await db.insertFile(file('1'));
  await db.insertFile(file('2', { name: 'HIV test result.pdf', locked: true }));
  for (const id of ['1', '2']) await db.replaceChunks(id, [{ fileId: id, text: `diagnosis secret ${id}`, page: 1, language: 'en' }]);
  await db.saveRecord({ fileId: '2', kind: 'bill', vendor: 'Clinic', amount: 5000, currency: 'INR' });
  await db.saveReminder('2', 'Pay Clinic', Date.now() + 1e6);
});

describe('locked documents and the cloud', () => {
  it('are never offered for embedding, answers or passage search', async () => {
    expect((await db.chunksMissingEmbedding()).map((c) => c.fileId)).toEqual(['1']);
    for (const c of await db.chunksMissingEmbedding()) await db.setChunkEmbedding(c.id!, [1]);
    expect((await db.chunksWithEmbeddings()).map((c) => c.fileId)).toEqual(['1']);
    expect((await db.searchableChunks()).map((c) => c.fileId)).toEqual(['1']);
  });

  it('match keyword search by name only, never by their text', async () => {
    expect((await db.keywordSearch(['diagnosis'])).map((f) => f.id)).toEqual(['1']);
    expect((await db.keywordSearch(['hiv'])).map((f) => f.id)).toEqual(['2']);
  });

  it('stop being embedded from the moment they are locked', async () => {
    await db.setLocked('1', true);
    expect(await db.chunksMissingEmbedding()).toEqual([]);
    await db.setLocked('1', false);
    expect(await db.chunksMissingEmbedding()).toHaveLength(1);
  });
});

describe('locked documents and the assistant', () => {
  const ops: ActionDeps['ops'] = { moveManually: async () => {}, rename: async () => 'x', moveToTrash: async () => {} };
  const pdf = new Proxy({}, { get: () => async () => [] }) as ActionDeps['pdf'];

  it('are hidden from search and lists, with only a count', async () => {
    const r = buildRegistry({ db, ops, pdf });
    const out = await r.invoke('files.list', {}, ctx);
    expect(out.status === 'done' && out.result.data).toMatchObject({ total: 1, lockedNotShown: 1 });
    expect(JSON.stringify(out)).not.toContain('HIV');
    const search = await r.invoke('files.search', { query: 'hiv test' }, ctx);
    expect(search.status === 'done' && search.result.files).toEqual([]);
  });

  it('cannot be used by id, even when the model knows it', async () => {
    const r = buildRegistry({ db, ops, pdf });
    for (const [id, args] of [['files.open', { fileId: '2' }], ['files.move', { fileId: '2', folder: 'Other' }], ['files.trash', { fileId: '2' }], ['pdf.compress', { fileId: '2' }]] as const) {
      const out = await r.invoke(id, args, ctx);
      // pdf.* fakes succeed, so they are checked through PdfTools below; files.* refuse here.
      if (id.startsWith('files.')) expect(out, id).toMatchObject({ status: 'error', error: expect.stringContaining('locked') });
    }
  });

  it('keep their bills and reminders out of summaries', async () => {
    const r = buildRegistry({ db, ops, pdf });
    const sum = await r.invoke('expenses.summary', {}, ctx);
    expect(sum.status === 'done' && sum.result.data).toMatchObject({ total: 0, count: 0 });
    const rem = await r.invoke('reminders.list', {}, ctx);
    expect(JSON.stringify(rem)).not.toContain('Clinic');
  });

  it('are refused by the PDF tools', async () => {
    const tools = new PdfTools({
      getFile: (id) => db.getFile(id),
      read: async () => new Blob(),
      importFile: async () => file('9'),
      moveManually: async () => {},
      engine: { run: async () => { throw new Error('should not run'); } } as never,
      rasterize: async () => [],
      toEmbeddable: async () => ({ bytes: new Uint8Array(), mime: 'image/png' }),
      textImage: async () => new Uint8Array(),
    });
    await expect(tools.compress('2')).rejects.toThrow(/locked/);
    await expect(tools.merge(['1', '2'])).rejects.toThrow(/locked/);
  });
});

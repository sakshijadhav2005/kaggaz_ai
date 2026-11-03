import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/core/crypto';
import { Db } from '../src/core/db';
import { IngestService } from '../src/core/ingestService';
import { Indexer } from '../src/index/indexer';
import type { Extractor, ReminderScheduler, VaultStore } from '../src/interfaces';
import type { ExtractedSegment } from '../src/models';
import { RuleClassifier, type RuleJson } from '../src/sort/ruleClassifier';
import rulesJson from '../src/sort/rules.json';
import { SmartSorter } from '../src/sort/smartSorter';

const cipher = await FieldCipher.fromRawKey(FieldCipher.generateRawKey());

class MemoryVault implements VaultStore {
  files = new Map<string, Blob>();
  async store(data: Blob, name: string, id: string, folder: string) {
    const path = `vault/${folder}/${id}_${name}`;
    this.files.set(path, data);
    return path;
  }
  async move(path: string, folder: string) {
    const dest = `vault/${folder}/${path.split('/').pop()}`;
    if (dest !== path) {
      this.files.set(dest, this.files.get(path)!);
      this.files.delete(path);
    }
    return dest;
  }
  async read(path: string) {
    return this.files.get(path)!;
  }
  async remove(path: string) {
    this.files.delete(path);
  }
}

const seg = (text: string, page = 1): ExtractedSegment => ({ page, text, language: 'en', confidence: 0.9, method: 'pdf_text' });

/** Returns whatever text the "file" is named after, so tests control extraction. */
const extractor = (texts: Record<string, ExtractedSegment[]>): Extractor => ({
  canHandle: () => true,
  extract: async (f) => texts[f.name] ?? [],
});

describe('ingest pipeline', () => {
  let db: Db, vault: MemoryVault, scheduled: { id: number; title: string; at: Date }[], cancelled: number[];
  let ingest: IngestService;

  const build = (texts: Record<string, ExtractedSegment[]>, embedFails = false) => {
    db = new Db(cipher, `test-${Math.random()}`);
    vault = new MemoryVault();
    scheduled = [];
    cancelled = [];
    const scheduler: ReminderScheduler = {
      schedule: async (id, title, at) => void scheduled.push({ id, title, at }),
      cancel: async (id) => void cancelled.push(id),
    };
    const embedder = { embed: async () => { if (embedFails) throw new Error('offline'); return [1, 0]; } };
    ingest = new IngestService(
      vault, db, [extractor(texts)],
      new SmartSorter(new RuleClassifier(rulesJson as RuleJson[]), () => false),
      new Indexer(db, embedder), scheduler,
    );
  };

  const upload = (name: string) => ingest.importFile(new File(['x'], name));

  beforeEach(() => build({}));

  it('sorts a bill into Bills, moves the file, and saves record and reminder', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000);
    const due = `${String(future.getDate()).padStart(2, '0')}/${String(future.getMonth() + 1).padStart(2, '0')}/${future.getFullYear()}`;
    build({ 'bill.pdf': [seg(`Adani Electricity\nUnits consumed 230\nAmount Payable: Rs. 1,840.50\nDue Date: ${due}`)] });

    const f = await upload('bill.pdf');
    expect(f).toMatchObject({ folder: 'Bills', status: 'ready', source: 'rule' });
    expect(f.path.startsWith('vault/Bills/')).toBe(true);
    expect(vault.files.has(f.path)).toBe(true);

    const [rec] = await db.records();
    expect(rec).toMatchObject({ kind: 'bill', vendor: 'Adani Electricity', amount: 1840.5, fileName: 'bill.pdf' });
    expect((await db.reminders())).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].title).toContain('Adani Electricity');
  });

  it('no text and no rule match lands in Unsorted as needs_review', async () => {
    const f = await upload('mystery.pdf');
    expect(f).toMatchObject({ folder: 'Unsorted', status: 'needs_review' });
  });

  it('a manual move survives Retry', async () => {
    const f = await upload('mystery.pdf');
    await ingest.moveManually(f, 'Study');
    await ingest.process(f); // stale copy on purpose
    expect(await db.getFile(f.id)).toMatchObject({ folder: 'Study', source: 'manual' });
  });

  it('edited text re-sorts and re-extracts', async () => {
    const f = await upload('mystery.pdf');
    await ingest.replaceText(f, 'Tax Invoice GST Total amount 500');
    expect(await db.getFile(f.id)).toMatchObject({ folder: 'Receipts', status: 'ready' });
    expect(await db.files('Receipts')).toHaveLength(1);
  });

  it('retry replaces the old reminder and cancels its alert', async () => {
    build({ 'bill.pdf': [seg('Power Co\nAmount Payable 100\nDue Date: 01/01/2099')] });
    const f = await upload('bill.pdf');
    const firstId = (await db.reminders())[0].id!;
    await ingest.process(f);
    expect(cancelled).toContain(firstId);
    expect(await db.reminders()).toHaveLength(1);
  });

  it('folder counts and keyword search work', async () => {
    build({ 'a.pdf': [seg('Amount Payable 100 Due Date 01/01/2099 Tata Power')] });
    await upload('a.pdf');
    expect(await db.folderCounts()).toEqual({ Bills: 1 });
    expect((await db.keywordSearch(['tata'])).map((x) => x.name)).toEqual(['a.pdf']);
    expect(await db.keywordSearch(['nothing'])).toEqual([]);
  });

  it('embeds chunks, and keeps them for later when embedding is unavailable', async () => {
    build({ 'a.pdf': [seg('Amount Payable 100')] });
    await upload('a.pdf');
    expect(await db.chunksWithEmbeddings()).toHaveLength(1);

    build({ 'a.pdf': [seg('Amount Payable 100')] }, true);
    await upload('a.pdf');
    expect(await db.chunksWithEmbeddings()).toHaveLength(0);
    expect(await db.chunksMissingEmbedding()).toHaveLength(1);
  });
});

describe('favourites and trash', () => {
  const future = new Date(Date.now() + 5 * 86_400_000);
  const due = `${String(future.getDate()).padStart(2, '0')}/${String(future.getMonth() + 1).padStart(2, '0')}/${future.getFullYear()}`;
  const bill = [seg(`Tata Power\nAmount Payable: Rs. 500\nDue Date: ${due}`)];

  let db: Db, vault: MemoryVault, ingest: IngestService, scheduled: number[], cancelled: number[];

  beforeEach(() => {
    db = new Db(cipher, `test-${Math.random()}`);
    vault = new MemoryVault();
    scheduled = [];
    cancelled = [];
    const scheduler: ReminderScheduler = {
      schedule: async (id) => void scheduled.push(id),
      cancel: async (id) => void cancelled.push(id),
    };
    ingest = new IngestService(
      vault, db, [extractor({ 'bill.pdf': bill })],
      new SmartSorter(new RuleClassifier(rulesJson as RuleJson[]), () => false),
      new Indexer(db, { embed: async () => [1, 0] }), scheduler,
    );
  });

  const upload = () => ingest.importFile(new File(['x'], 'bill.pdf'));

  it('favourites toggle and are listed separately', async () => {
    const f = await upload();
    expect(await db.favorites()).toEqual([]);
    await ingest.toggleFavorite(f);
    expect((await db.favorites()).map((x) => x.id)).toEqual([f.id]);
    expect(await db.specialCounts()).toEqual({ favorites: 1, trash: 0 });
    await ingest.toggleFavorite((await db.getFile(f.id))!);
    expect(await db.favorites()).toEqual([]);
  });

  it('trash hides the file from folders, search, answers, expenses and reminders', async () => {
    const f = await upload();
    expect(await db.reminders()).toHaveLength(1);
    await ingest.moveToTrash(f);

    expect(await db.files()).toEqual([]);
    expect(await db.files('Bills')).toEqual([]);
    expect(await db.folderCounts()).toEqual({});
    expect(await db.keywordSearch(['tata'])).toEqual([]);
    expect(await db.searchableChunks()).toEqual([]);
    expect(await db.chunksWithEmbeddings()).toEqual([]);
    expect(await db.records()).toEqual([]);
    expect(await db.reminders()).toEqual([]);
    expect((await db.trash()).map((x) => x.id)).toEqual([f.id]);
    expect(await db.specialCounts()).toEqual({ favorites: 0, trash: 1 });
    expect(cancelled).toHaveLength(1); // its alert was cancelled
    expect(vault.files.has(f.path)).toBe(true); // nothing is deleted yet
  });

  it('restore brings everything back and re-arms the alert', async () => {
    const f = await upload();
    await ingest.moveToTrash(f);
    scheduled.length = 0;
    await ingest.restore(f);

    expect((await db.files()).map((x) => x.id)).toEqual([f.id]);
    expect(await db.keywordSearch(['tata'])).toHaveLength(1);
    expect(await db.records()).toHaveLength(1);
    expect(await db.reminders()).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(await db.trash()).toEqual([]);
  });

  it('delete forever removes the file, text, record and reminder', async () => {
    const f = await upload();
    await ingest.moveToTrash(f);
    await ingest.deleteForever(f);

    expect(vault.files.has(f.path)).toBe(false);
    expect(await db.getFile(f.id)).toBeUndefined();
    expect(await db.trash()).toEqual([]);
    expect(await db.searchableChunks()).toEqual([]);
    expect(await db.records()).toEqual([]);
    expect(await db.reminders()).toEqual([]);
  });

  it('empty trash only removes trashed files', async () => {
    const keep = await ingest.importFile(new File(['x'], 'bill.pdf'));
    const drop = await ingest.importFile(new File(['y'], 'bill.pdf'));
    await ingest.moveToTrash(drop);
    await ingest.emptyTrash();
    expect((await db.files()).map((x) => x.id)).toEqual([keep.id]);
    expect(await db.trash()).toEqual([]);
  });
});

describe('renaming', () => {
  let db: Db, ingest: IngestService;
  const build = (suggest?: (text: string) => Promise<string | null>) => {
    db = new Db(cipher, `test-${Math.random()}`);
    ingest = new IngestService(
      new MemoryVault(), db, [extractor({ 'scan.pdf': [seg('Adani Electricity\nAmount Payable: Rs. 500')] })],
      new SmartSorter(new RuleClassifier(rulesJson as RuleJson[]), () => false),
      new Indexer(db, { embed: async () => [1, 0] }), undefined, suggest,
    );
  };

  it('keeps the extension and cleans the name', async () => {
    build();
    const f = await ingest.importFile(new File(['x'], 'scan.pdf'));
    expect(await ingest.rename(f, '  Electricity: "Aug"/2025  ')).toBe('Electricity Aug 2025.pdf');
    expect((await db.getFile(f.id))!.name).toBe('Electricity Aug 2025.pdf');
  });

  it('rejects an empty name', async () => {
    build();
    const f = await ingest.importFile(new File(['x'], 'scan.pdf'));
    await expect(ingest.rename(f, ' /// ')).rejects.toThrow(/empty/i);
    expect((await db.getFile(f.id))!.name).toBe('scan.pdf');
  });

  it('a renamed file is found by its new name', async () => {
    build();
    const f = await ingest.importFile(new File(['x'], 'scan.pdf'));
    await ingest.rename(f, 'Zebra Invoice');
    expect((await db.keywordSearch(['zebra'])).map((x) => x.id)).toEqual([f.id]);
  });

  it('names the file from its content when asked (Gemma 4, online or on the device)', async () => {
    const seen: string[] = [];
    build(async (text) => (seen.push(text), 'Adani Electricity Bill'));
    const f = await ingest.importFile(new File(['x'], 'scan.pdf'), { autoName: true });
    expect(f.name).toBe('Adani Electricity Bill.pdf');
    expect(seen[0]).toContain('Amount Payable');
  });

  it('keeps the typed name when auto-naming is off', async () => {
    build(async () => 'Should Not Be Used');
    const f = await ingest.importFile(new File(['x'], 'My own name.pdf'));
    expect(f.name).toBe('My own name.pdf');
  });

  it('keeps the original name if the suggestion fails or the file has no text', async () => {
    build(async () => { throw new Error('model unavailable'); });
    expect((await ingest.importFile(new File(['x'], 'scan.pdf'), { autoName: true })).name).toBe('scan.pdf');
    build(async () => 'Never Used');
    expect((await ingest.importFile(new File(['x'], 'blank.pdf'), { autoName: true })).name).toBe('blank.pdf');
  });
});

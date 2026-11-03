import { z } from 'zod';

import type { Db } from '../core/db';
import { strings } from '../i18n';
import { FOLDERS, type Folder, type StoredFile } from '../models';
import type { PdfTools } from '../pdf/pdfTools';
import { folderForQuery, keywordTokens } from '../search/folderSearch';
import { ActionRegistry, APP_TABS, defineAction } from './registry';

/** What the actions need. IngestService and Db provide these in the app; tests pass fakes. */
export interface ActionDeps {
  db: Pick<Db, 'getFile' | 'files' | 'favorites' | 'keywordSearch' | 'reminders' | 'records' | 'setReminderDone' | 'setFavorite'>;
  /* Locked documents are invisible to the assistant: not listed, not searchable, not usable by id. */
  ops: {
    moveManually(file: StoredFile, folder: Folder): Promise<void>;
    rename(file: StoredFile, stem: string): Promise<string>;
    moveToTrash(file: StoredFile): Promise<void>;
  };
  pdf: Pick<PdfTools, 'merge' | 'extractPages' | 'split' | 'deletePages' | 'rotate' | 'compress' | 'watermark' | 'addPageNumbers' | 'imagesToPdf'>;
}

const MAX_RESULTS = 10;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What the model sees about a file. Never its text. */
const meta = (f: StoredFile) => ({ id: f.id, name: f.name, folder: f.folder, type: f.type, added: day(f.importedAt), favorite: !!f.favorite });

// Models sometimes send ids as numbers; ids are strings.
const fileId = z.coerce.string().min(1).describe('id from a search or list result');
const folder = z.enum(FOLDERS);
const pages = z.string().min(1).describe('pages counted from 1, like "1-3, 5"');
const newName = z.string().max(80).optional().describe('name for the new file, without extension');

/** PDF tools always make new documents; the result tells the model which. */
const created = (made: StoredFile[]) => ({ data: { created: made.map(meta) }, files: made });

export function buildRegistry({ db, ops, pdf }: ActionDeps): ActionRegistry {
  /** A file the user can act on. Trash and locked documents are off limits to the assistant. */
  async function need(id: string): Promise<StoredFile> {
    const f = await db.getFile(id);
    if (!f || f.deletedAt) throw new Error(`No document with id ${id}. Search for it first.`);
    if (f.locked) throw new Error('That document is locked. The assistant cannot use it; the user can unlock it in the viewer.');
    return f;
  }

  /** Ids of locked files, for filtering reminders and bills. */
  const lockedIds = async (ids: string[]) => {
    const out = new Set<string>();
    for (const id of new Set(ids)) if ((await db.getFile(id))?.locked) out.add(id);
    return out;
  };

  /** Locked files are dropped; the model is told how many, never which. */
  const found = (all: StoredFile[]) => {
    const open = all.filter((f) => !f.locked);
    const shown = open.slice(0, MAX_RESULTS);
    const locked = all.length - open.length;
    return { data: { total: open.length, documents: shown.map(meta), ...(locked ? { lockedNotShown: locked } : {}) }, files: shown };
  };

  return new ActionRegistry().register(
    defineAction({
      id: 'files.search',
      summary: 'Find documents by name, folder or words inside them. Use this before acting on a document.',
      args: z.object({ query: z.string().min(1).describe('words to look for') }),
      handler: async ({ query }) => {
        const out = new Map<string, StoredFile>();
        const f = folderForQuery(query);
        if (f) for (const x of await db.files(f)) out.set(x.id, x);
        const tokens = keywordTokens(query);
        if (tokens.length) for (const x of await db.keywordSearch(tokens)) out.set(x.id, x);
        return found([...out.values()]);
      },
    }),

    defineAction({
      id: 'files.list',
      summary: 'List the newest documents, optionally only one folder or only favourites.',
      args: z.object({ folder: folder.optional(), favorites: z.boolean().optional() }),
      handler: async ({ folder: f, favorites }) => {
        const all = favorites ? (await db.favorites()).filter((x) => !f || x.folder === f) : await db.files(f);
        return found(all);
      },
    }),

    defineAction({
      id: 'files.open',
      summary: 'Open a document on screen for the user.',
      args: z.object({ fileId, page: z.coerce.number().int().positive().optional() }),
      handler: async ({ fileId: id, page }, ctx) => {
        const f = await need(id);
        ctx.openFile(f.id, page);
        return { data: { opened: f.name }, files: [f] };
      },
    }),

    defineAction({
      id: 'files.move',
      summary: 'Move a document to another folder.',
      args: z.object({ fileId, folder }),
      handler: async ({ fileId: id, folder: to }) => {
        const f = await need(id);
        await ops.moveManually(f, to);
        return { data: { moved: f.name, from: f.folder, to }, files: [{ ...f, folder: to }] };
      },
    }),

    defineAction({
      id: 'files.setFavorite',
      summary: 'Add a document to favourites (favorite true) or remove it (false).',
      args: z.object({ fileId, favorite: z.boolean() }),
      handler: async ({ fileId: id, favorite }) => {
        const f = await need(id);
        await db.setFavorite(f.id, favorite);
        return { data: { name: f.name, favorite }, files: [{ ...f, favorite }] };
      },
    }),

    defineAction({
      id: 'files.rename',
      summary: 'Rename a document. Give the new name without the extension; the extension is kept.',
      args: z.object({ fileId, name: z.string().min(1).max(120) }),
      handler: async ({ fileId: id, name }) => {
        const f = await need(id);
        const newName = await ops.rename(f, name.replace(/\.[a-z0-9]{2,4}$/i, ''));
        return { data: { from: f.name, to: newName }, files: [{ ...f, name: newName }] };
      },
    }),

    defineAction({
      id: 'files.trash',
      summary: 'Move a document to Trash. The user is asked to confirm; they can restore it from Trash.',
      args: z.object({ fileId }),
      requiresConfirmation: true,
      confirmText: async ({ fileId: id }) => strings().agent.trashQuestion((await need(id)).name),
      doneText: (d: { trashed: string }) => strings().agent.trashed(d.trashed),
      handler: async ({ fileId: id }) => {
        const f = await need(id);
        await ops.moveToTrash(f);
        return { data: { trashed: f.name } };
      },
    }),

    defineAction({
      id: 'reminders.list',
      summary: 'List bill reminders: what is due and when.',
      args: z.object({ includeDone: z.boolean().optional() }),
      handler: async ({ includeDone }) => {
        const open = (await db.reminders()).filter((r) => includeDone || !r.done);
        const locked = await lockedIds(open.map((r) => r.fileId));
        const all = open.filter((r) => !locked.has(r.fileId));
        return {
          data: { total: all.length, reminders: all.slice(0, MAX_RESULTS).map((r) => ({ id: r.id, title: r.title, due: day(r.dueAt), done: r.done, fileId: r.fileId })) },
        };
      },
    }),

    defineAction({
      id: 'reminders.markDone',
      summary: 'Mark a reminder as done (or not done with done false).',
      args: z.object({ reminderId: z.coerce.number().int().describe('id from reminders.list'), done: z.boolean().optional() }),
      handler: async ({ reminderId, done = true }) => {
        const r = (await db.reminders()).find((x) => x.id === reminderId);
        if (!r) throw new Error(`No reminder with id ${reminderId}. List reminders first.`);
        await need(r.fileId);
        await db.setReminderDone(reminderId, done);
        return { data: { title: r.title, done } };
      },
    }),

    defineAction({
      id: 'expenses.summary',
      summary: 'Total of bills and receipts, for one month or for all time.',
      args: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('YYYY-MM') }),
      handler: async ({ month }) => {
        const inMonth = (await db.records()).filter((r) => !month || (r.docDate !== undefined && day(r.docDate).startsWith(month)));
        const locked = await lockedIds(inMonth.map((r) => r.fileId));
        const rows = inMonth.filter((r) => !locked.has(r.fileId));
        const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
        return {
          data: {
            month: month ?? 'all',
            currency: 'INR',
            total: Math.round(total * 100) / 100,
            count: rows.length,
            items: rows.slice(0, MAX_RESULTS).map((r) => ({ vendor: r.vendor ?? r.fileName, amount: r.amount, date: r.docDate ? day(r.docDate) : undefined, kind: r.kind, fileId: r.fileId })),
          },
        };
      },
    }),

    defineAction({
      id: 'pdf.merge',
      summary: 'Join several PDFs into one new PDF, in the order given. The originals stay.',
      args: z.object({ fileIds: z.array(fileId).min(2), name: newName }),
      handler: async ({ fileIds, name }) => created(await pdf.merge(fileIds, name)),
    }),

    defineAction({
      id: 'pdf.extractPages',
      summary: 'Make a new PDF from some pages of a PDF.',
      args: z.object({ fileId, pages }),
      handler: async ({ fileId: id, pages: p }) => created(await pdf.extractPages(id, p)),
    }),

    defineAction({
      id: 'pdf.split',
      summary: 'Split a PDF into several new PDFs: one per range like "1-2, 3-5", or one per page if pages is left out.',
      args: z.object({ fileId, pages: pages.optional() }),
      handler: async ({ fileId: id, pages: p }) => created(await pdf.split(id, p)),
    }),

    defineAction({
      id: 'pdf.deletePages',
      summary: 'Make a copy of a PDF without some pages. The original stays.',
      args: z.object({ fileId, pages }),
      handler: async ({ fileId: id, pages: p }) => created(await pdf.deletePages(id, p)),
    }),

    defineAction({
      id: 'pdf.rotate',
      summary: 'Make a copy of a PDF with pages turned clockwise (all pages if pages is left out).',
      args: z.object({ fileId, angle: z.enum(['90', '180', '270']), pages: pages.optional() }),
      handler: async ({ fileId: id, angle, pages: p }) => created(await pdf.rotate(id, Number(angle) as 90 | 180 | 270, p)),
    }),

    defineAction({
      id: 'pdf.compress',
      summary: 'Make a smaller copy of a PDF, e.g. for upload limits. "strong" is smallest but less sharp.',
      args: z.object({ fileId, level: z.enum(['balanced', 'strong']).optional() }),
      handler: async ({ fileId: id, level }) => created(await pdf.compress(id, level)),
    }),

    defineAction({
      id: 'pdf.watermark',
      summary: 'Make a copy of a PDF with diagonal text on every page, e.g. "Copy for KYC only" or "केवल KYC के लिए".',
      args: z.object({ fileId, text: z.string().min(1).max(60) }),
      handler: async ({ fileId: id, text }) => created(await pdf.watermark(id, text)),
    }),

    defineAction({
      id: 'pdf.addPageNumbers',
      summary: 'Make a copy of a PDF with page numbers at the bottom.',
      args: z.object({ fileId }),
      handler: async ({ fileId: id }) => created(await pdf.addPageNumbers(id)),
    }),

    defineAction({
      id: 'pdf.imagesToPdf',
      summary: 'Make one PDF from photos or images, one per page, in the order given.',
      args: z.object({ fileIds: z.array(fileId).min(1), name: newName }),
      handler: async ({ fileIds, name }) => created(await pdf.imagesToPdf(fileIds, name)),
    }),

    defineAction({
      id: 'app.openTab',
      summary: 'Switch the app to a tab: library, ask, tools (PDF tools), expenses or reminders.',
      args: z.object({ tab: z.enum(APP_TABS) }),
      handler: async ({ tab }, ctx) => {
        ctx.openTab(tab);
        return { data: { opened: tab } };
      },
    }),
  );
}

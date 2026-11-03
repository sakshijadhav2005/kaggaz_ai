import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildRegistry, type ActionDeps } from '../src/agent/actions';
import { buildAgentPrompt, firstJsonObject, MAX_ROUNDS, parseModelStep, runAgent, runConfirmed } from '../src/agent/agent';
import { ActionRegistry, defineAction, type ActionContext } from '../src/agent/registry';
import { actionsFor, matchSkills, SKILLS } from '../src/agent/skills';
import { FieldCipher } from '../src/core/crypto';
import { Db } from '../src/core/db';
import type { LlmClient } from '../src/interfaces';
import type { StoredFile } from '../src/models';

const cipher = await FieldCipher.fromRawKey(FieldCipher.generateRawKey());
const SECRET_TEXT = 'PAN ABCDE1234F belongs to Asha';

const file = (id: string, name: string, folder: StoredFile['folder'], over: Partial<StoredFile> = {}): StoredFile => ({
  id, name, folder, type: 'pdf', path: `vault/${folder}/${id}.kgz`, status: 'ready', source: 'rule', language: 'en',
  importedAt: Date.parse('2026-10-01'), text: SECRET_TEXT, ...over,
});

/** Replies in order; records every prompt. */
function scripted(...replies: string[]) {
  const prompts: string[] = [];
  const llm: LlmClient = {
    complete: async (p) => {
      prompts.push(p);
      return replies.shift() ?? '{"reply":"(script ended)"}';
    },
    completeWithImage: async () => '',
  };
  return { llm, prompts };
}

const act = (action: string, args: unknown) => JSON.stringify({ action, args });
const reply = (text: string) => JSON.stringify({ reply: text });

let db: Db;
let registry: ActionRegistry;
let opened: { file?: string; tab?: string };
let ctx: ActionContext;
let trashed: string[];

beforeEach(async () => {
  db = new Db(cipher, `agent-${Math.random()}`);
  await db.insertFile(file('1', 'PAN card.pdf', 'PAN'));
  await db.insertFile(file('2', 'Electricity bill August.pdf', 'Bills', { importedAt: Date.parse('2026-08-05') }));
  await db.insertFile(file('3', 'Old PAN copy.pdf', 'PAN', { deletedAt: Date.now() }));
  await db.saveRecord({ fileId: '2', kind: 'bill', vendor: 'BSES', amount: 1250.5, currency: 'INR', docDate: Date.parse('2026-08-05') });
  trashed = [];
  const ops: ActionDeps['ops'] = {
    moveManually: async (f, folder) => void (await db.updateFile(f.id, { folder, source: 'manual' })),
    rename: async (f, stem) => {
      const name = `${stem}.pdf`;
      await db.updateFile(f.id, { name });
      return name;
    },
    moveToTrash: async (f) => {
      trashed.push(f.id);
      await db.moveToTrash(f.id);
    },
  };
  const made = (name: string): StoredFile[] => [file('new', name, 'PAN')];
  const pdf: ActionDeps['pdf'] = {
    merge: async (ids, name) => made(`${name ?? `merged ${ids.join('+')}`}.pdf`),
    extractPages: async () => made('pages.pdf'),
    split: async () => made('part.pdf'),
    deletePages: async () => made('edited.pdf'),
    rotate: async () => made('rotated.pdf'),
    compress: async () => made('compressed.pdf'),
    watermark: async () => made('watermarked.pdf'),
    addPageNumbers: async () => made('numbered.pdf'),
    imagesToPdf: async () => made('images.pdf'),
  };
  registry = buildRegistry({ db, ops, pdf });
  opened = {};
  ctx = { openFile: (id) => void (opened.file = id), openTab: (t) => void (opened.tab = t) };
});

describe('registry', () => {
  it('checks definitions when they are made', () => {
    const args = z.object({});
    expect(() => defineAction({ id: 'Bad Id', summary: 'x', args, handler: async () => ({ data: 1 }) })).toThrow(/area.verb/);
    expect(() => defineAction({ id: 'a.b', summary: ' ', args, handler: async () => ({ data: 1 }) })).toThrow(/summary/);
    expect(() => defineAction({ id: 'a.b', summary: 'x', args, requiresConfirmation: true, handler: async () => ({ data: 1 }) })).toThrow(/confirmText/);
    const d = defineAction({ id: 'a.b', summary: 'x', args, handler: async () => ({ data: 1 }) });
    expect(() => new ActionRegistry().register(d, d)).toThrow(/twice/);
  });

  it('describes actions from their schemas', () => {
    const text = registry.describe(['files.move', 'files.list']);
    expect(text).toContain('- files.move(fileId: string (id from a search or list result), folder: "Aadhaar" | "PAN"');
    expect(text).toContain('files.list(folder?:');
    expect(text).not.toContain('files.trash');
  });

  it('every skill names only registered actions', () => {
    for (const s of SKILLS) for (const id of s.actions) expect(registry.ids()).toContain(id);
  });

  it('validates arguments, coerces numeric ids and gates confirmation', async () => {
    expect(await registry.invoke('files.move', { fileId: '1', folder: 'Nowhere' }, ctx)).toMatchObject({ status: 'error', error: expect.stringContaining('folder') });
    expect(await registry.invoke('files.fly', {}, ctx)).toMatchObject({ status: 'error' });
    expect(await registry.invoke('files.move', { fileId: 1, folder: 'Study' }, ctx)).toMatchObject({ status: 'done' });
    expect((await db.getFile('1'))?.folder).toBe('Study');

    expect(await registry.invoke('files.trash', { fileId: '1' }, ctx)).toEqual({
      status: 'needs_confirmation', question: 'Move "PAN card.pdf" to Trash?', actionId: 'files.trash', args: { fileId: '1' },
    });
    expect(trashed).toEqual([]);
    expect(await runConfirmed(registry, 'files.trash', { fileId: '1' }, ctx)).toContain('Moved "PAN card.pdf" to Trash');
    expect(trashed).toEqual(['1']);
  });

  it('refuses unknown and trashed documents', async () => {
    expect(await registry.invoke('files.open', { fileId: '99' }, ctx)).toMatchObject({ status: 'error', error: expect.stringContaining('Search for it first') });
    expect(await registry.invoke('files.rename', { fileId: '3', name: 'x' }, ctx)).toMatchObject({ status: 'error' });
  });

  it('returns metadata, never document text', async () => {
    for (const [id, args] of [['files.search', { query: 'pan' }], ['files.list', {}], ['expenses.summary', { month: '2026-08' }]] as const) {
      const out = await registry.invoke(id, args, ctx);
      expect(out.status).toBe('done');
      expect(JSON.stringify(out.status === 'done' && out.result.data)).not.toContain('ABCDE1234F');
    }
  });

  it('searches by folder and by words, without Trash', async () => {
    const out = await registry.invoke('files.search', { query: 'pan card' }, ctx);
    expect(out.status === 'done' && out.result.files?.map((f) => f.id)).toEqual(['1']);
  });

  it('sums expenses by month', async () => {
    const out = await registry.invoke('expenses.summary', { month: '2026-08' }, ctx);
    expect(out.status === 'done' && out.result.data).toMatchObject({ total: 1250.5, count: 1 });
    const none = await registry.invoke('expenses.summary', { month: '2026-09' }, ctx);
    expect(none.status === 'done' && none.result.data).toMatchObject({ total: 0, count: 0 });
  });
});

describe('skills', () => {
  it.each([
    ['move my PAN card to Study', ['organize']],
    ['rename the electricity bill', ['organize']],
    ['आधार कार्ड हटाओ', ['organize']],
    ['open my pan card', ['open']],
    ['how much did I spend in August?', ['expenses']],
    ['मेरा खर्च कितना है', ['expenses']],
    ['when is the bill due', ['reminders']],
    ['give me Aadhaar card', []],
    ['what was the August bill?', []],
    ['removal of tonsils notes', []],
    ['merge my Aadhaar and PAN', ['pdf-tools']],
    ['compress the electricity bill', ['pdf-tools']],
    ['add page numbers to my resume', ['pdf-tools']],
    ['आधार और पैन मर्ज करो', ['pdf-tools']],
    ['what is in the bill pdf?', []],
  ])('%s', (q, names) => {
    expect(matchSkills(q).map((s) => s.name)).toEqual(names);
  });

  it('merges actions without duplicates', () => {
    const ids = actionsFor(SKILLS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parsing the model', () => {
  it('finds the JSON object in fenced or chatty output', () => {
    expect(parseModelStep('```json\n{"action":"files.search","args":{"query":"pan"}}\n```')).toEqual({ kind: 'action', action: 'files.search', args: { query: 'pan' } });
    expect(parseModelStep('Sure! {"reply":"Done {really}"} hope that helps')).toEqual({ kind: 'reply', text: 'Done {really}' });
    expect(firstJsonObject('{"a":"}"}')).toBe('{"a":"}"}');
  });

  it('treats plain or broken output as a reply', () => {
    expect(parseModelStep('I moved it.')).toEqual({ kind: 'reply', text: 'I moved it.' });
    expect(parseModelStep('{"action": broken')).toMatchObject({ kind: 'reply' });
    expect(parseModelStep('')).toMatchObject({ kind: 'reply', text: expect.stringContaining('could not') });
  });
});

describe('agent loop', () => {
  const organize = actionsFor(matchSkills('move'));

  it('searches, acts and replies', async () => {
    const { llm, prompts } = scripted(act('files.search', { query: 'pan card' }), act('files.move', { fileId: '1', folder: 'Study' }), reply('Moved PAN card.pdf to Study.'));
    const out = await runAgent('move my PAN card to Study', { llm, registry, ctx, actionIds: organize });
    expect(out).toMatchObject({ kind: 'reply', text: 'Moved PAN card.pdf to Study.' });
    expect(out.files?.[0]).toMatchObject({ id: '1', folder: 'Study' });
    expect((await db.getFile('1'))?.folder).toBe('Study');
    // The model saw the search result, never the document text.
    expect(prompts[1]).toContain('"id":"1","name":"PAN card.pdf"');
    for (const p of prompts) expect(p).not.toContain('ABCDE1234F');
  });

  it('stops for confirmation before trashing', async () => {
    const { llm } = scripted(act('files.trash', { fileId: '2' }));
    const out = await runAgent('delete the electricity bill', { llm, registry, ctx, actionIds: organize });
    expect(out).toMatchObject({ kind: 'confirm', question: 'Move "Electricity bill August.pdf" to Trash?', actionId: 'files.trash' });
    expect(trashed).toEqual([]);
  });

  it('feeds errors back so the model can correct itself', async () => {
    const { llm, prompts } = scripted(act('files.move', { fileId: '42', folder: 'Study' }), act('files.search', { query: 'pan' }), reply('Which one?'));
    await runAgent('move pan', { llm, registry, ctx, actionIds: organize });
    expect(prompts[1]).toContain('No document with id 42');
  });

  it('refuses actions outside the matched skills', async () => {
    const { llm, prompts } = scripted(act('app.openTab', { tab: 'expenses' }), reply('ok'));
    await runAgent('rename it', { llm, registry, ctx, actionIds: organize });
    expect(opened.tab).toBeUndefined();
    expect(prompts[1]).toContain('not available');
  });

  it('stops a model that repeats itself or never replies', async () => {
    const same = act('files.list', {});
    const { llm, prompts } = scripted(same, same, reply('Here they are.'));
    expect(await runAgent('list', { llm, registry, ctx, actionIds: organize })).toMatchObject({ text: 'Here they are.' });
    expect(prompts[2]).toContain('You already did exactly this');

    const endless = scripted(...Array.from({ length: 10 }, (_, i) => act('files.search', { query: `q${i}` })));
    const out = await runAgent('x', { llm: endless.llm, registry, ctx, actionIds: organize });
    expect(out.kind === 'reply' && out.text).toContain('could not finish');
    expect(endless.prompts).toHaveLength(MAX_ROUNDS);
  });

  it('runs PDF tools without confirmation and reports the new document', async () => {
    const tools = actionsFor(matchSkills('merge'));
    const { llm, prompts } = scripted(act('pdf.merge', { fileIds: ['1', '2'], name: 'KYC' }), reply('Made KYC.pdf.'));
    const out = await runAgent('merge pan and bill into KYC', { llm, registry, ctx, actionIds: tools });
    expect(out).toMatchObject({ kind: 'reply', text: 'Made KYC.pdf.' });
    expect(out.files?.[0].name).toBe('KYC.pdf');
    expect(prompts[1]).toContain('"created":[{"id":"new","name":"KYC.pdf"');
    expect(await registry.invoke('pdf.merge', { fileIds: ['1'] }, ctx)).toMatchObject({ status: 'error' });
    expect(await registry.invoke('pdf.rotate', { fileId: '1', angle: '45' }, ctx)).toMatchObject({ status: 'error' });
  });

  it('opens documents and tabs through the context', async () => {
    const open = actionsFor(matchSkills('open'));
    await runAgent('open pan', { llm: scripted(act('files.open', { fileId: '1' }), reply('Opened.')).llm, registry, ctx, actionIds: open });
    expect(opened.file).toBe('1');
  });

  it('puts earlier documents and their ids in the prompt for follow-ups', () => {
    const p = buildAgentPrompt('the first one', [], {
      registry,
      actionIds: organize,
      history: [{ role: 'assistant', text: 'Which one?', files: [{ id: '1', name: 'PAN card.pdf' }] }],
      today: new Date('2026-11-04'),
    });
    expect(p).toContain('"PAN card.pdf" id 1');
    expect(p).toContain('Today is 2026-11-04');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Answerer, NOT_FOUND, type Answer } from '../src/answer/answerer';
import { searchContent, type ContentSearchDeps } from '../src/answer/contentSearch';
import { heuristicName, joinName, parseSuggestedName, sanitizeStem, splitName } from '../src/core/naming';
import type { LlmClient } from '../src/interfaces';
import { LOCAL_MODEL } from '../src/llm/localModel';
import { OnDeviceLlmClient, errorText, explainLoadError } from '../src/llm/onDevice';
import { RoutedLlmClient } from '../src/llm/router';
import type { SnippetHit } from '../src/search/snippets';

// A stand-in for the native plugin: it lets the tests play the model's events.
const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const emit = (name: string, e: unknown) => listeners.get(name)?.forEach((fn) => fn(e));
  const state = {
    chats: 0,
    downloads: 0,
    failDownload: false,
    /** When set, setModel rejects the way the real plugin does: `{ message, code: <real reason> }`. */
    failLoad: '',
    /** Fractions of the model file that exist on disk, one per step of the fake download. */
    steps: [1] as number[],
    fileSize: 0,
    modelBytes: 0,
    active: 0,
    maxActive: 0,
    sent: [] as string[],
    modelCalls: [] as any[],
    onSend: (_chatId: string, _message: string) => {},
  };
  const CapgoLLM = {
    addListener: async (name: string, fn: (e: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return { remove: async () => void listeners.get(name)!.delete(fn) };
    },
    createChat: async () => ({ id: `chat${++state.chats}` }),
    setModel: async (o: unknown) => {
      state.modelCalls.push(o);
      if (state.failLoad) throw { message: 'Failed to load model', code: state.failLoad };
    },
    sendMessage: async ({ chatId, message }: { chatId: string; message: string }) => {
      state.sent.push(message);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      queueMicrotask(() => state.onSend(chatId, message));
    },
    downloadModel: async () => {
      state.downloads++;
      state.fileSize = 0;
      for (const f of state.steps) {
        await new Promise((r) => setTimeout(r, 25));
        state.fileSize = Math.floor(state.modelBytes * f);
      }
      if (state.failDownload) throw new Error('HTTP 401: sign in to Hugging Face');
      emit('downloadProgress', { progress: 7 });
      return { path: '/data/gemma-4-E2B-it.litertlm' };
    },
  };
  return { CapgoLLM, emit, state };
});
vi.mock('@capgo/capacitor-llm', () => ({ CapgoLLM: fake.CapgoLLM }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: {
    // Like the real plugin: fails while the file does not exist yet.
    stat: async () => {
      if (fake.state.fileSize === 0) throw new Error('File does not exist');
      return { size: fake.state.fileSize };
    },
  },
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' } }));

const memoryStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('file names', () => {
  it('splits and joins around the extension', () => {
    expect(splitName('Resume final.pdf')).toEqual({ stem: 'Resume final', ext: '.pdf' });
    expect(splitName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
    expect(splitName('noext')).toEqual({ stem: 'noext', ext: '' });
    expect(splitName('.hidden')).toEqual({ stem: '.hidden', ext: '' });
    expect(joinName('  Aadhaar   front ', '.png')).toBe('Aadhaar front.png');
  });

  it('removes characters files cannot contain', () => {
    expect(sanitizeStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(sanitizeStem('...secret')).toBe('secret');
    expect(sanitizeStem('x'.repeat(200))).toHaveLength(80);
  });

  it('cleans a model reply into a name', () => {
    expect(parseSuggestedName('"Adani Electricity Bill August 2025"')).toBe('Adani Electricity Bill August 2025');
    expect(parseSuggestedName('File name: Sakshi Jadhav Resume.pdf')).toBe('Sakshi Jadhav Resume');
    expect(parseSuggestedName('```\nTata Power Receipt\n```\nThis is a receipt.')).toBe('Tata Power Receipt');
    expect(parseSuggestedName('**Prescription Dr Rao**')).toBe('Prescription Dr Rao');
    expect(parseSuggestedName('')).toBeNull();
    expect(parseSuggestedName('"."')).toBeNull();
  });

  it('falls back to the first title-like line when no model is available', () => {
    expect(heuristicName('Adani Electricity\nUnits consumed 230')).toBe('Adani Electricity');
    expect(heuristicName('12345\n!!!')).toBeNull();
    expect(heuristicName('')).toBeNull();
  });
});

describe('on-device Gemma 4 client', () => {
  let client: OnDeviceLlmClient;

  beforeEach(() => {
    Object.assign(fake.state, { chats: 0, downloads: 0, failDownload: false, failLoad: '', steps: [1], fileSize: 0, modelBytes: LOCAL_MODEL.bytes, active: 0, maxActive: 0, sent: [], modelCalls: [], onSend: () => {} });
    client = new OnDeviceLlmClient(memoryStore(), 5); // read the file size every 5 ms
  });

  /** Plays a reply as the plugin would: text events, then aiFinished. */
  const reply = (...chunks: string[]) => {
    fake.state.onSend = (chatId) => {
      for (const text of chunks) fake.emit('textFromAi', { chatId, text, isChunk: true });
      fake.state.active--;
      fake.emit('aiFinished', { chatId });
    };
  };

  it('is not installed until the model has been downloaded', async () => {
    expect(client.isInstalled()).toBe(false);
    await expect(client.complete('hi')).rejects.toThrow(/not installed/i);
  });

  it('downloads the model, reports progress, and loads it as litertlm', async () => {
    const seen: number[] = [];
    await client.download((p) => seen.push(p));
    expect(seen).toEqual([7]);
    expect(client.isInstalled()).toBe(true);
    expect(fake.state.modelCalls[0]).toMatchObject({ path: '/data/gemma-4-E2B-it.litertlm', modelType: 'litertlm' });
  });

  it('shares one download between callers, and reports progress to subscribers', async () => {
    const seen: (number | null)[] = [];
    const off = client.subscribe(() => seen.push(client.downloadPercent()));
    expect(client.downloadPercent()).toBeNull();
    await Promise.all([client.download(), client.download(), client.download()]);
    off();
    expect(fake.state.downloads).toBe(1);
    expect(seen).toContain(0);
    expect(seen).toContain(7);
    expect(seen.at(-1)).toBeNull(); // finished
    expect(client.downloadPercent()).toBeNull();
    expect(client.lastError()).toBe('');
  });

  it('keeps the error of a failed download, and can be retried', async () => {
    fake.state.failDownload = true;
    await expect(client.download()).rejects.toThrow('401');
    expect(client.lastError()).toContain('401');
    expect(client.isInstalled()).toBe(false);
    expect(client.downloadPercent()).toBeNull();

    fake.state.failDownload = false;
    await client.download();
    expect(client.lastError()).toBe('');
    expect(client.isInstalled()).toBe(true);
  });

  it('shows real progress for a file over 2 GB, where the plugin reports none', async () => {
    // The plugin reads the size as a 32-bit number, so it sends no progress events for this model.
    fake.state.steps = [0.2, 0.5, 0.8, 1];
    const seen: number[] = [];
    await client.download((p) => seen.push(p));
    const fromFile = seen.filter((p) => p !== 7); // 7 is the plugin's own (fake) event
    const near = (n: number) => fromFile.some((p) => Math.abs(p - n) <= 1);
    expect(near(20) && near(50) && near(80)).toBe(true);
    expect(Math.max(...fromFile)).toBeLessThan(100); // 100 is only for "done"
    expect(fromFile).toEqual([...fromFile].sort((a, b) => a - b)); // never goes backwards
    expect(client.isInstalled()).toBe(true);
  });

  it('refuses a download that stopped early', async () => {
    fake.state.steps = [0.5];
    await expect(client.download()).rejects.toThrow(/stopped early \(50%\)/);
    expect(client.isInstalled()).toBe(false);
    expect(client.lastError()).toContain('stopped early');
    expect(fake.state.modelCalls).toHaveLength(0); // a short file is never loaded
  });

  it('reloads the model every few requests, because the plugin never frees finished chats', async () => {
    await client.download(() => {});
    reply('ok');
    expect(fake.state.modelCalls).toHaveLength(1);
    for (let i = 0; i < 4; i++) await client.complete(`q${i}`);
    expect(fake.state.modelCalls).toHaveLength(1); // four requests, still the same load
    await client.complete('q4');
    expect(fake.state.modelCalls).toHaveLength(2); // the fifth reloads first
    expect(fake.state.chats).toBe(5);
    for (let i = 0; i < 4; i++) await client.complete(`r${i}`);
    expect(fake.state.modelCalls).toHaveLength(3);
  });

  it('joins streamed chunks into one reply', async () => {
    await client.download(() => {});
    reply('Hel', 'lo ', 'there');
    expect(await client.complete('say hello')).toBe('Hello there');
    expect(fake.state.sent).toEqual(['say hello']);
  });

  it('a full-text event replaces the chunks so far', async () => {
    await client.download(() => {});
    fake.state.onSend = (chatId) => {
      fake.emit('textFromAi', { chatId, text: 'partial', isChunk: true });
      fake.emit('textFromAi', { chatId, text: 'final answer', isChunk: false });
      fake.state.active--;
      fake.emit('aiFinished', { chatId });
    };
    expect(await client.complete('q')).toBe('final answer');
  });

  it('ignores events from other chats', async () => {
    await client.download(() => {});
    fake.state.onSend = (chatId) => {
      fake.emit('textFromAi', { chatId: 'someone-else', text: 'WRONG', isChunk: true });
      fake.emit('textFromAi', { chatId, text: 'right', isChunk: true });
      fake.state.active--;
      fake.emit('aiFinished', { chatId });
    };
    expect(await client.complete('q')).toBe('right');
  });

  it('surfaces a generation error', async () => {
    await client.download(() => {});
    fake.state.onSend = (chatId) => {
      fake.state.active--;
      fake.emit('generationError', { chatId, error: 'out of memory' });
    };
    await expect(client.complete('q')).rejects.toThrow('out of memory');
  });

  it('runs one request at a time', async () => {
    await client.download(() => {});
    reply('ok');
    await Promise.all([client.complete('a'), client.complete('b'), client.complete('c')]);
    expect(fake.state.sent).toEqual(['a', 'b', 'c']);
    expect(fake.state.maxActive).toBe(1);
  });

  it('a failed request does not block the next one', async () => {
    await client.download(() => {});
    fake.state.onSend = (chatId) => {
      fake.state.active--;
      fake.emit('generationError', { chatId, error: 'boom' });
    };
    await expect(client.complete('a')).rejects.toThrow('boom');
    reply('fine');
    expect(await client.complete('b')).toBe('fine');
  });

  it('cannot read images', async () => {
    await expect(client.completeWithImage()).rejects.toThrow(/online/i);
  });
});

describe('why the on-device model fails to start', () => {
  let client: OnDeviceLlmClient;
  beforeEach(() => {
    Object.assign(fake.state, { chats: 0, downloads: 0, failDownload: false, failLoad: '', steps: [1], fileSize: 0, modelBytes: LOCAL_MODEL.bytes, active: 0, maxActive: 0, sent: [], modelCalls: [], onSend: () => {} });
    client = new OnDeviceLlmClient(memoryStore(), 5);
  });

  it('errorText shows the real reason, which the plugin puts in `code`', () => {
    expect(errorText({ message: 'Failed to load model', code: 'out of memory' })).toBe('Failed to load model: out of memory');
    expect(errorText({ message: 'Only a message' })).toBe('Only a message');
    expect(errorText({ message: 'Same', code: 'Same' })).toBe('Same');
    expect(errorText(new Error('plain error'))).toBe('plain error');
    expect(errorText('just text')).toBe('just text');
  });

  it('adds advice only when the reason looks like running out of memory', () => {
    expect(explainLoadError('std::bad_alloc')).toContain('close other apps');
    expect(explainLoadError('Failed to mmap model')).toContain('close other apps');
    expect(explainLoadError('unsupported model version 7')).toBe('unsupported model version 7');
  });

  it('downloaded but would not start: keeps the file, reports the real reason, and retries without downloading again', async () => {
    fake.state.failLoad = 'bad_alloc';
    await expect(client.download()).rejects.toThrow(/could not start: .*bad_alloc/);
    expect(client.isInstalled()).toBe(true); // the 2.6 GB file is kept
    expect(client.loadError()).toContain('bad_alloc');
    expect(client.loadError()).toContain('close other apps');
    expect(fake.state.downloads).toBe(1);

    fake.state.failLoad = '';
    await client.retryLoad();
    expect(client.loadError()).toBe('');
    expect(fake.state.downloads).toBe(1); // no second download
    expect(fake.state.modelCalls).toHaveLength(2);
  });

  it('a request while the model cannot start fails with the real reason, and recovers once it can', async () => {
    await client.download(() => {});
    fake.state.failLoad = 'unsupported model version 7';
    await client.retryLoad().catch(() => undefined);
    await expect(client.complete('hi')).rejects.toThrow(/could not start: .*unsupported model version 7/);
    expect(client.loadError()).toContain('unsupported model version 7');

    fake.state.failLoad = '';
    fake.state.onSend = (chatId) => {
      fake.emit('textFromAi', { chatId, text: 'ok', isChunk: true });
      fake.state.active--;
      fake.emit('aiFinished', { chatId });
    };
    expect(await client.complete('hi')).toBe('ok');
    expect(client.loadError()).toBe('');
  });

  it('tells subscribers when starting fails or recovers', async () => {
    await client.download(() => {});
    let notified = 0;
    client.subscribe(() => notified++);
    fake.state.failLoad = 'x';
    await client.retryLoad().catch(() => undefined);
    const afterFail = notified;
    fake.state.failLoad = '';
    await client.retryLoad();
    expect(afterFail).toBeGreaterThan(0);
    expect(notified).toBeGreaterThan(afterFail);
  });

  it('download again starts over and replaces the record', async () => {
    await client.download(() => {});
    expect(fake.state.downloads).toBe(1);
    await client.redownload();
    expect(fake.state.downloads).toBe(2);
    expect(client.isInstalled()).toBe(true);
  });

  it('a file even slightly short is refused instead of being loaded', async () => {
    fake.state.steps = [0.995];
    await expect(client.download()).rejects.toThrow(/stopped early/);
    expect(fake.state.modelCalls).toHaveLength(0);
    expect(client.isInstalled()).toBe(false);
  });
});

describe('model router', () => {
  const llm = (name: string, fail = false): LlmClient & { calls: number } => ({
    calls: 0,
    async complete() {
      this.calls++;
      if (fail) throw new Error(`${name} failed`);
      return name;
    },
    async completeWithImage() {
      this.calls++;
      return `${name}-image`;
    },
  });
  const local = (installed: boolean) => ({ installed, calls: 0, isInstalled() { return this.installed; }, async complete() { this.calls++; return 'local'; } });

  it('uses the hosted model when online with a key', async () => {
    const h = llm('hosted'), l = local(true);
    const r = new RoutedLlmClient(h, l, () => true);
    expect(await r.complete('q')).toBe('hosted');
    expect(l.calls).toBe(0);
  });

  it('uses Gemma 4 on the device when offline', async () => {
    const h = llm('hosted'), l = local(true);
    const r = new RoutedLlmClient(h, l, () => false);
    expect(await r.complete('q')).toBe('local');
    expect(h.calls).toBe(0);
  });

  it('falls back to the device when the hosted call fails', async () => {
    const r = new RoutedLlmClient(llm('hosted', true), local(true), () => true);
    expect(await r.complete('q')).toBe('local');
  });

  it('reports the hosted error when there is no on-device model', async () => {
    const r = new RoutedLlmClient(llm('hosted', true), local(false), () => true);
    await expect(r.complete('q')).rejects.toThrow('hosted failed');
  });

  it('explains what to do when nothing is available', async () => {
    const r = new RoutedLlmClient(llm('hosted'), local(false), () => false);
    expect(r.available()).toBe(false);
    await expect(r.complete('q')).rejects.toThrow(/download offline Gemma 4/i);
  });

  it('knows when some model is available', () => {
    expect(new RoutedLlmClient(llm('h'), local(true), () => false).available()).toBe(true);
    expect(new RoutedLlmClient(llm('h'), local(false), () => true).available()).toBe(true);
    expect(new RoutedLlmClient(llm('h'), null, () => false).available()).toBe(false);
  });

  it('reads images only through the hosted model', async () => {
    const h = llm('hosted');
    expect(await new RoutedLlmClient(h, local(true), () => true).completeWithImage('p', 'b64', 'image/png')).toBe('hosted-image');
    await expect(new RoutedLlmClient(h, local(true), () => false).completeWithImage('p', 'b64', 'image/png')).rejects.toThrow(/internet/i);
  });
});

describe('answering from passages (offline path)', () => {
  const files = new Map([['f1', 'resume.pdf'], ['f2', 'bill.pdf'], ['f3', 'other.pdf']]);
  const source = {
    chunksWithEmbeddings: async () => [],
    getFile: async (id: string) => (files.has(id) ? ({ id, name: files.get(id)!, folder: 'Other' } as never) : undefined),
  };
  const noEmbed = { embed: async () => { throw new Error('offline'); } };
  const llm = (text: string, seen: string[] = []): LlmClient => ({
    complete: async (p) => (seen.push(p), text),
    completeWithImage: async () => '',
  });
  const passages = [1, 2, 3, 4].map((n) => ({ fileId: `f${Math.min(n, 3)}`, page: n, text: `passage ${n}` }));

  it('needs no network, and takes at most 3 passages', async () => {
    const seen: string[] = [];
    await new Answerer(source, noEmbed, llm('x', seen)).askFromPassages('q', passages);
    expect(seen[0]).toContain('[3] passage 3');
    expect(seen[0]).not.toContain('passage 4');
  });

  it('maps cited numbers back to files and pages, and ignores invented ones', async () => {
    const a = await new Answerer(source, noEmbed, llm('Skills: Python [1] and SQL [2][9]')).askFromPassages('q', passages);
    expect(a.citations.map((c) => [c.fileName, c.page])).toEqual([['resume.pdf', 1], ['bill.pdf', 2]]);
  });
});

describe('searching file content', () => {
  const hit = (fileName: string, text = 't'): SnippetHit => ({ fileId: 'f1', fileName, folder: 'Other', page: 1, snippet: 's', text, score: 2, matched: ['x'] });
  const answer = (text: string): Answer => ({ text, citations: [{ fileId: 'f1', fileName: 'resume.pdf', folder: 'Other', page: 1 }] });
  const log: string[] = [];

  const deps = (over: Partial<ContentSearchDeps> = {}): ContentSearchDeps => ({
    online: true,
    hasKey: true,
    localReady: false,
    askHosted: async () => (log.push('hosted'), answer('Python [1]')),
    findPassages: async () => (log.push('passages'), [hit('resume.pdf')]),
    askFromPassages: async () => (log.push('local'), answer('Python [1]')),
    general: async () => (log.push('general'), 'Paris'),
    ...over,
  });

  beforeEach(() => {
    log.length = 0;
  });

  it('online: answers with the hosted model and cites the file', async () => {
    const r = await searchContent('q', deps());
    expect(r.text).toBe('Python [1]');
    expect(r.citations?.[0].fileName).toBe('resume.pdf');
    expect(log).toEqual(['hosted']);
  });

  it('answers a mobile-number request with only the matching number and a downloadable source citation', async () => {
    const findPassages = vi.fn(async () => [hit('Sakshi_Jadhav_Resume.pdf', 'Sakshi Jadhav\nPhone: +91 98765 43210')]);
    const r = await searchContent(
      'What is the mobile number of Sakshi Jadhav?',
      deps({ findPassages }),
    );
    expect(r.text).toBe('Mobile number: 9876543210.');
    expect(r.citations).toEqual([{ fileId: 'f1', fileName: 'Sakshi_Jadhav_Resume.pdf', folder: 'Other', page: 1 }]);
    expect(r.snippets).toBeUndefined();
    expect(findPassages).toHaveBeenCalledOnce();
    expect(findPassages).toHaveBeenCalledWith('What is the mobile number of Sakshi Jadhav?');
  });

  it('retries a one-word person search so the mobile answer does not need Gemma', async () => {
    const calls: string[] = [];
    const r = await searchContent(
      'Mobile number of Rajesh?',
      deps({
        findPassages: async (q) => {
          calls.push(q);
          return q === 'rajesh' ? [hit('contact.pdf', 'Rajesh\nPhone: 98765 43210')] : [];
        },
      }),
    );
    expect(r.text).toBe('Mobile number: 9876543210.');
    expect(calls).toEqual(['Mobile number of Rajesh?', 'rajesh']);
    expect(log).toEqual([]);
  });

  it('does not answer a mobile-number request from an unrelated number or ID', async () => {
    const queries: string[] = [];
    const r = await searchContent(
      'What is the mobile number of Sakshi Jadhav?',
      deps({
        findPassages: async (q) => {
          queries.push(q);
          return [hit('ID.pdf', 'Someone else. Mobile: 98765 43210. Aadhaar: 1234 5678 9012.')];
        },
      }),
    );
    expect(r.text).toBe(NOT_FOUND);
    expect(r.citations).toBeUndefined();
    expect(queries).toEqual(['What is the mobile number of Sakshi Jadhav?', 'sakshi jadhav']);
  });

  it.each([
    'mobile number on adhar card',
    'aadhaar card mobile number',
    'what is mobile number in aadhaar card pic',
    'fetch mobile number from uploaded aadhar card image',
  ])('finds the mobile number on an ID card photo whose text shares no words with "%s"', async (q) => {
    const card = hit('IMG_2025.jpg', 'Government of India\nSakshi Jadhav\n4567 8912 3456\nMob: 98765 43210\nआधार');
    const r = await searchContent(q, deps({ findPassages: async () => [], allPassages: async () => [card] }));
    expect(r.text).toBe('Mobile number: 9876543210.');
    expect(r.citations?.[0].fileName).toBe('IMG_2025.jpg');
  });

  it('finds a mobile number by the name on the card when the address sits between them', async () => {
    const card = hit('eaadhaar.jpg', 'Unique Identification Authority of India\nTo\nSakshi Jadhav\n' +
      'D/O Ramesh Jadhav, Flat 12, Shivaji Nagar, Near Ganesh Temple, Kothrud, Pune, Maharashtra - 411038\n' +
      'VTC: Pune, District: Pune, State: Maharashtra\nMobile: 9876543210\n4567 8912 3456');
    const r = await searchContent('sakshi jadhav mobile no', deps({ findPassages: async () => [], allPassages: async () => [card] }));
    expect(r.text).toBe('Mobile number: 9876543210.');
  });

  it('does not give a named person someone else\'s number from a list of contacts', async () => {
    const list = hit('contacts.pdf', 'Sakshi Jadhav, Flat 12, Shivaji Nagar, Kothrud, Pune, Maharashtra 411038, India. Emergency contacts follow.\n' +
      'Rahul Patil, House 45, MG Road, Camp Area, Nashik, Maharashtra 422001, India. Office reception desk.\nMobile: 98220 11223\n' +
      'Asha More, Plot 7, Station Road, Satara, Maharashtra 415001, India. Branch office reception.\nMobile: 99887 76655');
    const r = await searchContent('mobile number of sakshi jadhav', deps({ findPassages: async () => [list], allPassages: async () => [list] }));
    expect(r.text).toBe(NOT_FOUND);
  });

  it('does not take an unlabelled number from an ID card as its mobile number', async () => {
    const card = hit('IMG_2025.jpg', 'Government of India\nRahul Patil\n4567 8912 3456\nRef 9876543210');
    const r = await searchContent('mobile number on adhar card', deps({ findPassages: async () => [], allPassages: async () => [card] }));
    expect(r.text).toBe(NOT_FOUND);
  });

  it('offline with Gemma 4 on the device: writes an answer from the matching passages', async () => {
    const r = await searchContent('q', deps({ online: false, localReady: true }));
    expect(log).toEqual(['passages', 'local']);
    expect(r.text).toContain('Answered on this device by Gemma 4');
    expect(r.citations).toHaveLength(1);
  });

  it('offline without the model: shows the passages and says how to get written answers', async () => {
    const r = await searchContent('q', deps({ online: false }));
    expect(r.snippets).toHaveLength(1);
    expect(r.text).toContain("You're offline");
    expect(r.text).toContain('Download offline Gemma 4');
    expect(log).toEqual(['passages']);
  });

  it('hosted model failed: falls back to the device', async () => {
    const r = await searchContent('q', deps({ localReady: true, askHosted: async () => { throw new Error('quota'); } }));
    expect(r.text).toContain('Answered on this device');
  });

  it('hosted model says not in the files: does not ask a weaker model, shows passages', async () => {
    const r = await searchContent('q', deps({ localReady: true, askHosted: async () => answer(NOT_FOUND) }));
    expect(r.snippets).toHaveLength(1);
    expect(log).not.toContain('local');
  });

  it('on-device failure still shows the passages', async () => {
    const r = await searchContent('q', deps({ online: false, localReady: true, askFromPassages: async () => { throw new Error('out of memory'); } }));
    expect(r.snippets).toHaveLength(1);
    expect(r.text).toContain('out of memory');
  });

  it('online AI off: points to Settings', async () => {
    const r = await searchContent('q', deps({ hasKey: false }));
    expect(r.text).toContain('Turn it on in Settings');
    expect(log).not.toContain('hosted');
  });

  it('nothing in the files: gives a labelled general answer', async () => {
    const online = await searchContent('q', deps({ askHosted: async () => answer(NOT_FOUND), findPassages: async () => [] }));
    expect(online.text).toContain('General answer (not from your files)');
    expect(online.text).toContain('Paris');
    const offline = await searchContent('q', deps({ online: false, localReady: true, findPassages: async () => [] }));
    expect(offline.text).toContain('Paris');
  });

  it('nothing in the files and no model: says not found', async () => {
    const r = await searchContent('q', deps({ online: false, findPassages: async () => [] }));
    expect(r.text).toBe(`${NOT_FOUND}\n${"You're offline."}`);
    expect(log).not.toContain('general');
  });

  it('a failing general answer falls back to not found', async () => {
    const r = await searchContent('q', deps({ findPassages: async () => [], askHosted: async () => answer(NOT_FOUND), general: async () => { throw new Error('x'); } }));
    expect(r.text).toBe(NOT_FOUND);
  });
});

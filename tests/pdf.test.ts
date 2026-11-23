import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { hi } from '../src/i18n/hi';

import type { StoredFile } from '../src/models';
import { handleRequest } from '../src/pdf/pdfDispatch';
import { PdfEngine, type Reply, type Request, type WorkerLike } from '../src/pdf/pdfEngine';
import * as ops from '../src/pdf/pdfOps';
import { MAX_INPUT_BYTES, PdfTools, type PdfToolsDeps } from '../src/pdf/pdfTools';

/** A PDF whose pages have distinct widths, so page order can be checked: page n is 100+n points wide. */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let n = 1; n <= pages; n++) doc.addPage([100 + n, 200]);
  return doc.save();
}

const widths = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth() - 100);

// 1x1 red PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

describe('page specs', () => {
  it('parses pages and ranges, 1-based', () => {
    expect(ops.parsePageSpec('1-3, 5', 6)).toEqual([0, 1, 2, 4]);
    expect(ops.parsePageSpec('4-', 6)).toEqual([3, 4, 5]);
    expect(ops.parsePageSpec('', 3)).toEqual([0, 1, 2]);
    expect(ops.parsePageSpec('all', 2)).toEqual([0, 1]);
    expect(ops.parsePageGroups('1-2,3', 3)).toEqual([[0, 1], [2]]);
  });

  it.each(['0', '7', '3-2', 'a', '1-2-3'])('rejects %s', (spec) => {
    expect(() => ops.parsePageSpec(spec, 6)).toThrow(ops.PdfOpError);
  });
});

describe('pdf operations', () => {
  it('merges in order', async () => {
    const out = await ops.merge([await makePdf(2), await makePdf(1)]);
    expect(await widths(out)).toEqual([1, 2, 1]);
    await expect(ops.merge([await makePdf(1)])).rejects.toThrow(/at least two/);
  });

  it('extracts pages in the order asked', async () => {
    expect(await widths(await ops.extractPages(await makePdf(5), '4, 1-2'))).toEqual([4, 1, 2]);
  });

  it('splits by ranges or into single pages', async () => {
    const pdf = await makePdf(4);
    expect(await Promise.all((await ops.split(pdf, '1-2, 3-4')).map(widths))).toEqual([[1, 2], [3, 4]]);
    expect(await ops.split(pdf)).toHaveLength(4);
    await expect(ops.split(pdf, '1-4')).rejects.toThrow(/just one file/);
  });

  it('deletes pages but never all of them', async () => {
    const pdf = await makePdf(4);
    expect(await widths(await ops.deletePages(pdf, '2, 4'))).toEqual([1, 3]);
    await expect(ops.deletePages(pdf, '1-4')).rejects.toThrow(/every page/);
  });

  it('rotates chosen pages', async () => {
    const out = await PDFDocument.load(await ops.rotate(await makePdf(3), 90, '2'));
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 0]);
    const all = await PDFDocument.load(await ops.rotate(await ops.rotate(await makePdf(1), 270), 180));
    expect(all.getPage(0).getRotation().angle).toBe(90);
  });

  it('watermarks and numbers pages, keeping the page count', async () => {
    const pdf = await makePdf(3);
    expect(await widths(await ops.watermark(pdf, 'Copy for KYC only'))).toEqual([1, 2, 3]);
    expect(await widths(await ops.addPageNumbers(pdf))).toEqual([1, 2, 3]);
    await expect(ops.watermark(pdf, 'केवल KYC')).rejects.toThrow(/image path/);
    expect(await widths(await ops.watermarkImage(pdf, PNG))).toEqual([1, 2, 3]);
    await expect(ops.watermark(pdf, '  ')).rejects.toThrow(/watermark text/);
  });

  it('makes a PDF from images, fitted to A4 or at a given size', async () => {
    const out = await PDFDocument.load(await ops.imagesToPdf([{ bytes: PNG, mime: 'image/png' }, { bytes: PNG, mime: 'image/png', widthPt: 300, heightPt: 400 }]));
    expect(out.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([[1, 1], [300, 400]]);
    const land = ops.fitA4({ width: 4000, height: 3000 }); // height-limited in landscape A4
    expect(land.h).toBeCloseTo(595.28);
    expect(land.w).toBeCloseTo((595.28 * 4) / 3);
    expect(ops.fitA4({ width: 3000, height: 4000 }).w).toBeCloseTo(595.28); // width-limited in portrait A4
  });

  it('gives a clear message for files that are not PDFs', async () => {
    await expect(ops.pageCount(new TextEncoder().encode('not a pdf'))).rejects.toThrow(/could not be read as a PDF/);
  });
});

describe('worker engine', () => {
  /** Runs requests in-process, transferring buffers exactly as a real worker would (which detaches them). */
  function fakeWorker(): WorkerLike & { posted: number } {
    let onMessage: (e: MessageEvent<Reply>) => void = () => {};
    const w = {
      posted: 0,
      postMessage(msg: unknown, transfer: Transferable[]) {
        w.posted++;
        const req = structuredClone(msg, { transfer }) as Request;
        void handleRequest(req).then(({ reply, transfer: back }) => onMessage({ data: structuredClone(reply, { transfer: back }) } as MessageEvent<Reply>));
      },
      addEventListener(type: string, fn: (e: never) => void) {
        if (type === 'message') onMessage = fn as typeof onMessage;
      },
      terminate() {},
    };
    return w;
  }

  it('runs operations and leaves the caller\'s bytes intact', async () => {
    const engine = new PdfEngine(fakeWorker);
    const a = await makePdf(2);
    const b = await makePdf(1);
    const merged = await engine.run('merge', [a, b]);
    expect(await widths(merged)).toEqual([1, 2, 1]);
    expect(a.byteLength).toBeGreaterThan(0); // not detached
    expect(await engine.run('pageCount', a)).toBe(2);
  });

  it('keeps user-facing errors as PdfOpError', async () => {
    const engine = new PdfEngine(fakeWorker);
    await expect(engine.run('extractPages', await makePdf(2), '9')).rejects.toBeInstanceOf(ops.PdfOpError);
  });

  it('carries the error code and parameters across the worker, for translation', async () => {
    const engine = new PdfEngine(fakeWorker);
    const err = await engine.run('extractPages', await makePdf(2), '9').catch((e) => e);
    expect(err).toBeInstanceOf(ops.PdfOpError);
    expect(err.code).toBe('outOfRange');
    expect(err.params).toEqual(['9', 2]);
    expect(err.message).toBe('Pages 9 are outside 1-2.');
    expect(err.textIn(hi.pdfErrors)).toBe('पेज 9, 1-2 के बाहर हैं।');
  });
});

describe('PdfTools', () => {
  const stored = (id: string, name: string, over: Partial<StoredFile> = {}): StoredFile => ({
    id, name, type: 'pdf', path: id, folder: 'PAN', status: 'ready', source: 'rule', language: 'en', importedAt: 1, text: '', ...over,
  });

  async function setup(files: Record<string, { file: StoredFile; bytes: Uint8Array }>) {
    const imported: StoredFile[] = [];
    const drawn: string[] = [];
    const moved: [string, string][] = [];
    const engine = new PdfEngine(() => {
      let onMessage: (e: MessageEvent<Reply>) => void = () => {};
      return {
        postMessage: (msg: unknown) => void handleRequest(msg as Request).then(({ reply }) => onMessage({ data: reply } as MessageEvent<Reply>)),
        addEventListener: (type: string, fn: (e: never) => void) => void (type === 'message' && (onMessage = fn as typeof onMessage)),
        terminate() {},
      };
    });
    const all = new Map(Object.entries(files));
    const deps: PdfToolsDeps = {
      getFile: async (id) => all.get(id)?.file ?? imported.find((f) => f.id === id),
      read: async (f) => new Blob([(all.get(f.id)?.bytes ?? new Uint8Array()) as Uint8Array<ArrayBuffer>]),
      importFile: async (f) => {
        const made = stored(`new${imported.length + 1}`, f.name, { folder: 'Unsorted' });
        all.set(made.id, { file: made, bytes: new Uint8Array(await f.arrayBuffer()) });
        imported.push(made);
        return made;
      },
      moveManually: async (f, folder) => {
        moved.push([f.id, folder]);
        all.get(f.id)!.file = { ...f, folder };
      },
      engine,
      rasterize: async () => [{ bytes: PNG, mime: 'image/png' }],
      toEmbeddable: async (b) => ({ bytes: new Uint8Array(await b.arrayBuffer()), mime: 'image/png' }),
      textImage: async (t) => {
        drawn.push(t);
        return PNG;
      },
    };
    return { tools: new PdfTools(deps), imported, moved, all, drawn };
  }

  it('saves results as new documents in the inputs\' folder', async () => {
    const { tools, moved, all } = await setup({ a: { file: stored('a', 'Aadhaar.pdf'), bytes: await makePdf(1) }, b: { file: stored('b', 'PAN.pdf'), bytes: await makePdf(2) } });
    const [made] = await tools.merge(['a', 'b']);
    expect(made).toMatchObject({ name: 'Aadhaar - merged.pdf', folder: 'PAN' });
    expect(moved).toEqual([[made.id, 'PAN']]);
    expect(await widths(all.get(made.id)!.bytes)).toEqual([1, 1, 2]);
    // Originals untouched.
    expect(await widths(all.get('a')!.bytes)).toEqual([1]);
  });

  it('leaves results to the sorter when inputs come from different folders', async () => {
    const { tools, moved } = await setup({ a: { file: stored('a', 'A.pdf'), bytes: await makePdf(1) }, b: { file: stored('b', 'B.pdf', { folder: 'Bills' }), bytes: await makePdf(1) } });
    await tools.merge(['a', 'b'], 'KYC set');
    expect(moved).toEqual([]);
  });

  it('names split parts and extracted pages', async () => {
    const { tools } = await setup({ a: { file: stored('a', 'Marksheet.pdf'), bytes: await makePdf(3) } });
    expect((await tools.split('a')).map((f) => f.name)).toEqual(['Marksheet - part 1.pdf', 'Marksheet - part 2.pdf', 'Marksheet - part 3.pdf']);
    expect((await tools.extractPages('a', '1 - 2'))[0].name).toBe('Marksheet - pages 1-2.pdf');
  });

  it('refuses wrong types, Trash and oversized input', async () => {
    const big = new Uint8Array(MAX_INPUT_BYTES + 1);
    const { tools } = await setup({
      img: { file: stored('img', 'photo.jpg', { type: 'image' }), bytes: PNG },
      gone: { file: stored('gone', 'old.pdf', { deletedAt: 5 }), bytes: await makePdf(1) },
      big: { file: stored('big', 'huge.pdf'), bytes: big },
    });
    await expect(tools.watermark('img', 'x')).rejects.toThrow(/not a PDF/);
    await expect(tools.addPageNumbers('gone')).rejects.toThrow(/No document/);
    await expect(tools.rotate('big', 90)).rejects.toThrow(/too large/);
    await expect(tools.imagesToPdf(['gone'])).rejects.toThrow(/No document/);
  });

  it('compresses only when the result is smaller', async () => {
    const padded = await PDFDocument.create();
    padded.addPage([100, 100]);
    padded.setSubject('x'.repeat(50_000)); // a big file that rebuilds small
    const { tools } = await setup({ fat: { file: stored('fat', 'Scan.pdf'), bytes: await padded.save({ useObjectStreams: false }) }, thin: { file: stored('thin', 'Tiny.pdf'), bytes: await makePdf(1) } });
    expect((await tools.compress('fat'))[0].name).toBe('Scan - compressed.pdf');
    await expect(tools.compress('thin')).rejects.toThrow(/already about as small/);
  });

  it('watermarks Latin text as PDF text and Hindi as a WebView-drawn image', async () => {
    const { tools, drawn, all } = await setup({ a: { file: stored('a', 'PAN.pdf'), bytes: await makePdf(2) } });
    await tools.watermark('a', 'Copy for KYC only');
    expect(drawn).toEqual([]);
    const [made] = await tools.watermark('a', 'केवल KYC के लिए');
    expect(drawn).toEqual(['केवल KYC के लिए']);
    expect(await widths(all.get(made.id)!.bytes)).toEqual([1, 2]);
    await expect(tools.watermark('a', '   ')).rejects.toThrow(/watermark text/);
  });

  it('makes a PDF from images', async () => {
    const { tools } = await setup({ i1: { file: stored('i1', 'Front.jpg', { type: 'image' }), bytes: PNG }, i2: { file: stored('i2', 'Back.jpg', { type: 'image' }), bytes: PNG } });
    expect((await tools.imagesToPdf(['i1', 'i2']))[0].name).toBe('Front and more.pdf');
  });
});

import { sanitizeStem, splitName } from '../core/naming';
import type { Folder, StoredFile } from '../models';
import type { PdfEngine } from './pdfEngine';
import { PdfOpError } from './pdfErrors';
import { LATIN, type PdfImage } from './pdfOps';

/*
 * The PDF tools as the app and the assistant use them: by document id, on the decrypted vault copy.
 * Every tool saves its result as a NEW document through the normal import (so it is encrypted, read,
 * indexed and searchable) and never changes the original. That is why the assistant may run these
 * without asking first.
 */

export interface PdfToolsDeps {
  getFile(id: string): Promise<StoredFile | undefined>;
  read(file: StoredFile): Promise<Blob>;
  importFile(file: File): Promise<StoredFile>;
  moveManually(file: StoredFile, folder: Folder): Promise<void>;
  engine: Pick<PdfEngine, 'run'>;
  /** Main thread only (needs a canvas): every page as a JPEG, sized in PDF points. */
  rasterize(pdf: Blob, level: CompressLevel): Promise<PdfImage[]>;
  /** Main thread only: JPEG and PNG pass through; other images are converted to JPEG. */
  toEmbeddable(image: Blob): Promise<PdfImage>;
  /** Main thread only: [text] drawn as a transparent PNG, so the WebView shapes Hindi and other scripts. */
  textImage(text: string): Promise<Uint8Array>;
}

export type CompressLevel = 'strong' | 'balanced';

/** pdf-lib holds whole files in memory; past this a phone can run out. */
export const MAX_INPUT_BYTES = 80 * 1024 * 1024;

const pdfName = (stem: string) => `${sanitizeStem(stem) || 'Document'}.pdf`;
const stemOf = (f: StoredFile) => splitName(f.name).stem;

export class PdfTools {
  constructor(private d: PdfToolsDeps) {}

  private async need(ids: string[], kind: 'pdf' | 'image'): Promise<StoredFile[]> {
    const files: StoredFile[] = [];
    for (const id of ids) {
      const f = await this.d.getFile(id);
      if (!f || f.deletedAt) throw new PdfOpError('noDocument', id);
      if (f.locked) throw new PdfOpError('locked', f.name);
      if (f.type !== kind) throw (kind === 'pdf' ? new PdfOpError('notPdfDoc', f.name) : new PdfOpError('notImageDoc', f.name));
      files.push(f);
    }
    return files;
  }

  private async bytes(files: StoredFile[]): Promise<Uint8Array[]> {
    const blobs = await Promise.all(files.map((f) => this.d.read(f)));
    if (blobs.reduce((s, b) => s + b.size, 0) > MAX_INPUT_BYTES) throw new PdfOpError('filesTooLarge');
    return Promise.all(blobs.map(async (b) => new Uint8Array(await b.arrayBuffer())));
  }

  /** Saves results as new documents. If every input was in one folder, the results go there too. */
  private async save(outputs: { bytes: Uint8Array; name: string }[], inputs: StoredFile[]): Promise<StoredFile[]> {
    const folders = new Set(inputs.map((f) => f.folder));
    const keep = folders.size === 1 ? [...folders][0] : null;
    const made: StoredFile[] = [];
    for (const o of outputs) {
      let f = await this.d.importFile(new File([o.bytes as Uint8Array<ArrayBuffer>], o.name, { type: 'application/pdf' }));
      if (keep && keep !== 'Unsorted' && f.folder !== keep) {
        await this.d.moveManually(f, keep);
        f = (await this.d.getFile(f.id)) ?? f;
      }
      made.push(f);
    }
    return made;
  }

  private async one(id: string): Promise<{ file: StoredFile; bytes: Uint8Array }> {
    const [file] = await this.need([id], 'pdf');
    const [bytes] = await this.bytes([file]);
    return { file, bytes };
  }

  /** Joins PDFs in the order given. */
  async merge(ids: string[], name?: string): Promise<StoredFile[]> {
    const files = await this.need(ids, 'pdf');
    const out = await this.d.engine.run('merge', await this.bytes(files));
    return this.save([{ bytes: out, name: pdfName(name ?? `${stemOf(files[0])} - merged`) }], files);
  }

  /** One new PDF with the pages in [pages] ("1-3, 5"). */
  async extractPages(id: string, pages: string): Promise<StoredFile[]> {
    const { file, bytes } = await this.one(id);
    const out = await this.d.engine.run('extractPages', bytes, pages);
    return this.save([{ bytes: out, name: pdfName(`${stemOf(file)} - pages ${pages.replace(/\s+/g, '')}`) }], [file]);
  }

  /** One new PDF per range in [pages] ("1-2, 3-5"), or one per page if [pages] is empty. */
  async split(id: string, pages?: string): Promise<StoredFile[]> {
    const { file, bytes } = await this.one(id);
    const parts = await this.d.engine.run('split', bytes, pages);
    return this.save(parts.map((b, i) => ({ bytes: b, name: pdfName(`${stemOf(file)} - part ${i + 1}`) })), [file]);
  }

  async deletePages(id: string, pages: string): Promise<StoredFile[]> {
    const { file, bytes } = await this.one(id);
    const out = await this.d.engine.run('deletePages', bytes, pages);
    return this.save([{ bytes: out, name: pdfName(`${stemOf(file)} - edited`) }], [file]);
  }

  async rotate(id: string, angle: 90 | 180 | 270, pages?: string): Promise<StoredFile[]> {
    const { file, bytes } = await this.one(id);
    const out = await this.d.engine.run('rotate', bytes, angle, pages);
    return this.save([{ bytes: out, name: pdfName(`${stemOf(file)} - rotated`) }], [file]);
  }

  async watermark(id: string, text: string): Promise<StoredFile[]> {
    const t = text.trim();
    if (!t) throw new PdfOpError('watermarkEmpty');
    const { file, bytes } = await this.one(id);
    // Latin text is drawn as real PDF text; anything else as an image the WebView rendered.
    const out = LATIN.test(t) ? await this.d.engine.run('watermark', bytes, t) : await this.d.engine.run('watermarkImage', bytes, await this.d.textImage(t));
    return this.save([{ bytes: out, name: pdfName(`${stemOf(file)} - watermarked`) }], [file]);
  }

  async addPageNumbers(id: string): Promise<StoredFile[]> {
    const { file, bytes } = await this.one(id);
    const out = await this.d.engine.run('addPageNumbers', bytes);
    return this.save([{ bytes: out, name: pdfName(`${stemOf(file)} - numbered`) }], [file]);
  }

  /**
   * Renders every page to JPEG and rebuilds the PDF. Lossy: text in the result is no longer selectable
   * (the import reads it again with OCR). Refuses when the result would not be smaller.
   */
  async compress(id: string, level: CompressLevel = 'balanced'): Promise<StoredFile[]> {
    const [file] = await this.need([id], 'pdf');
    const blob = await this.d.read(file);
    if (blob.size > MAX_INPUT_BYTES) throw new PdfOpError('fileTooLarge');
    const out = await this.d.engine.run('imagesToPdf', await this.d.rasterize(blob, level));
    if (out.byteLength >= blob.size * 0.95) throw new PdfOpError('alreadySmall', file.name);
    return this.save([{ bytes: out, name: pdfName(`${stemOf(file)} - compressed`) }], [file]);
  }

  /** One page per image, in the order given. */
  async imagesToPdf(ids: string[], name?: string): Promise<StoredFile[]> {
    const files = await this.need(ids, 'image');
    const blobs = await Promise.all(files.map((f) => this.d.read(f)));
    if (blobs.reduce((s, b) => s + b.size, 0) > MAX_INPUT_BYTES) throw new PdfOpError('imagesTooLarge');
    const images: PdfImage[] = [];
    for (const b of blobs) images.push(await this.d.toEmbeddable(b));
    const out = await this.d.engine.run('imagesToPdf', images);
    return this.save([{ bytes: out, name: pdfName(name ?? `${stemOf(files[0])}${files.length > 1 ? ' and more' : ''}`) }], files);
  }
}

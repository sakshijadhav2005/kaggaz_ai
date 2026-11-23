import { PdfOpError } from './pdfErrors';
import * as ops from './pdfOps';
import { buffers, type Reply, type Request } from './pdfEngine';

/* Worker side of the PDF engine. Only the worker imports this file, so pdf-lib stays out of the main bundle. */

export const OPS = {
  pageCount: (b: Uint8Array) => ops.pageCount(b),
  merge: (pdfs: Uint8Array[]) => ops.merge(pdfs),
  extractPages: (b: Uint8Array, spec: string) => ops.extractPages(b, spec),
  split: (b: Uint8Array, spec?: string) => ops.split(b, spec),
  deletePages: (b: Uint8Array, spec: string) => ops.deletePages(b, spec),
  rotate: (b: Uint8Array, angle: 90 | 180 | 270, spec?: string) => ops.rotate(b, angle, spec),
  watermark: (b: Uint8Array, text: string) => ops.watermark(b, text),
  watermarkImage: (b: Uint8Array, png: Uint8Array) => ops.watermarkImage(b, png),
  addPageNumbers: (b: Uint8Array) => ops.addPageNumbers(b),
  imagesToPdf: (images: ops.PdfImage[]) => ops.imagesToPdf(images),
};

/** The worker side: runs one request. Exported for tests. */
export async function handleRequest(req: Request): Promise<{ reply: Reply; transfer: ArrayBuffer[] }> {
  try {
    const fn = OPS[req.op] as (...a: unknown[]) => Promise<unknown>;
    if (!fn) throw new Error(`Unknown PDF operation ${req.op}`);
    const result = await fn(...req.args);
    return { reply: { id: req.id, ok: true, result }, transfer: buffers(result) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // A user-facing error crosses as its code and parameters, so the main thread can show it in the user's language.
    const coded = e instanceof PdfOpError ? { code: e.code, params: e.params as unknown[] } : {};
    return { reply: { id: req.id, ok: false, error, userFacing: e instanceof PdfOpError, ...coded }, transfer: [] };
  }
}

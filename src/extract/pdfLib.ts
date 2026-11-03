// The legacy build carries polyfills (Iterator and others), so it also runs in WebViews older than Chrome 122.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from './pdfWorker?worker';

// Vite bundles the worker itself, so no dynamic import of a node_modules URL is needed
// (that path is what fails as "Setting up fake worker failed" when the dev server is stale).
// Each document gets its own worker: closing one PDF must never shut down another's
// (thumbnails render while an import is still extracting).
const workers = new WeakMap<PdfDoc, pdfjs.PDFWorker>();

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function openPdf(blob: Blob): Promise<PdfDoc> {
  // pdf.js accepts a Worker here; its published typings declare `port` as null.
  const worker = new pdfjs.PDFWorker({ port: new PdfWorker() as unknown as null });
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), worker }).promise;
    workers.set(doc, worker);
    return doc;
  } catch (e) {
    worker.destroy();
    throw e;
  }
}

/** Frees the document and its worker. Safe to call once per openPdf. */
export async function closePdf(doc: PdfDoc): Promise<void> {
  await doc.loadingTask.destroy();
  workers.get(doc)?.destroy();
}

/** Plain text of a page, with line breaks where the PDF has them. */
export async function pageText(doc: PdfDoc, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : ''))
    .join('')
    .trim();
}

export async function renderPage(doc: PdfDoc, pageNumber: number, scale: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

import { closePdf, openPdf, renderPage } from '../extract/pdfLib';
import type { CompressLevel } from './pdfTools';
import { PdfOpError } from './pdfErrors';
import type { PdfImage } from './pdfOps';

/* Canvas work for the PDF tools. Main thread only: pdf.js rendering and image decoding need a canvas. */

/** Render scale and JPEG quality. 1.5x keeps a scanned A4 page readable; 1.1x is for sharing by chat apps. */
const LEVELS: Record<CompressLevel, { scale: number; quality: number }> = {
  balanced: { scale: 1.5, quality: 0.7 },
  strong: { scale: 1.1, quality: 0.5 },
};

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality));

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** Every page as a JPEG, one page in memory at a time. Page sizes stay as in the original. */
export async function rasterize(pdf: Blob, level: CompressLevel): Promise<PdfImage[]> {
  const { scale, quality } = LEVELS[level];
  const doc = await openPdf(pdf);
  try {
    const out: PdfImage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 }); // PDF points
      const canvas = await renderPage(doc, n, scale);
      // JPEG has no transparency: paint white under the page first.
      const flat = document.createElement('canvas');
      flat.width = canvas.width;
      flat.height = canvas.height;
      const g = flat.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, flat.width, flat.height);
      g.drawImage(canvas, 0, 0);
      out.push({ bytes: await bytesOf(await toBlob(flat, 'image/jpeg', quality)), mime: 'image/jpeg', widthPt: width, heightPt: height });
      canvas.width = canvas.height = flat.width = flat.height = 0; // free the pixels now, not at GC
    }
    return out;
  } finally {
    await closePdf(doc);
  }
}

/** [text] in grey on a transparent background, as PNG. The WebView shapes Devanagari and other scripts. */
export async function textImage(text: string): Promise<Uint8Array> {
  const size = 120;
  const font = `bold ${size}px "Noto Sans Devanagari", "Noto Sans", sans-serif`;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const m = probe.measureText(text);
  const pad = size * 0.25;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(m.width + pad * 2);
  // Devanagari has a head line above and vowel signs below the baseline: leave room for both.
  canvas.height = Math.ceil(size * 1.6 + pad);
  const g = canvas.getContext('2d')!;
  g.font = font;
  g.fillStyle = 'rgb(115, 115, 115)';
  g.textBaseline = 'middle';
  g.fillText(text, pad, canvas.height / 2);
  return bytesOf(await toBlob(canvas, 'image/png'));
}

/** JPEG and PNG go in as they are; WebP (and HEIC where the WebView can decode it) become JPEG. */
export async function toEmbeddable(image: Blob): Promise<PdfImage> {
  const head = await bytesOf(image.slice(0, 8));
  if (head[0] === 0xff && head[1] === 0xd8) return { bytes: await bytesOf(image), mime: 'image/jpeg' };
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return { bytes: await bytesOf(image), mime: 'image/png' };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new PdfOpError('This image format cannot be read on this phone. Use JPEG or PNG.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { bytes: await bytesOf(await toBlob(canvas, 'image/jpeg', 0.9)), mime: 'image/jpeg' };
}

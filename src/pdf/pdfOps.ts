import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/*
 * PDF page operations on raw bytes, with pdf-lib (MIT). No DOM, so they run in a Web Worker (pdfOps.worker.ts)
 * and in Node tests. Every operation returns new bytes; the input is never changed.
 * Page numbers are 1-based everywhere a person or the model sees them, 0-based inside this file.
 */

import { PdfOpError } from './pdfErrors';

export { PdfOpError };

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(String(e))) throw new PdfOpError('This PDF is password-protected, so it cannot be changed.');
    throw new PdfOpError('This file could not be read as a PDF.');
  }
}

const save = (doc: PDFDocument) => doc.save({ useObjectStreams: true });

/**
 * "1-3, 5, 8-" -> 0-based page indexes in the order given. Empty means every page.
 * "8-" runs to the last page. Throws on pages that do not exist.
 */
export function parsePageSpec(spec: string | undefined, pageCount: number): number[] {
  const groups = parsePageGroups(spec, pageCount);
  return groups.flat();
}

/** Like parsePageSpec, but keeps each comma-separated part apart: "1-2, 3-5" -> [[0,1],[2,3,4]]. */
export function parsePageGroups(spec: string | undefined, pageCount: number): number[][] {
  const s = (spec ?? '').replace(/\s+/g, '');
  if (s === '' || s.toLowerCase() === 'all') return [Array.from({ length: pageCount }, (_, i) => i)];
  return s.split(',').filter(Boolean).map((part) => {
    const m = /^(\d+)(?:-(\d*))?$/.exec(part);
    if (!m) throw new PdfOpError(`"${part}" is not a page or range. Use numbers like 1-3, 5.`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === '' ? pageCount : Number(m[2]);
    if (from < 1 || to > pageCount || from > to) throw new PdfOpError(`Pages ${part} are outside 1-${pageCount}.`);
    return Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  });
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await load(bytes)).getPageCount();
}

export async function merge(pdfs: Uint8Array[]): Promise<Uint8Array> {
  if (pdfs.length < 2) throw new PdfOpError('Pick at least two PDFs to merge.');
  const out = await PDFDocument.create();
  for (const bytes of pdfs) {
    const src = await load(bytes);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return save(out);
}

/** A new PDF with the given pages, in the given order. */
export async function extractPages(bytes: Uint8Array, spec: string): Promise<Uint8Array> {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(src, parsePageSpec(spec, src.getPageCount()))) out.addPage(p);
  return save(out);
}

/** One PDF per comma-separated part of [spec]; with no spec, one PDF per page. */
export async function split(bytes: Uint8Array, spec?: string): Promise<Uint8Array[]> {
  const src = await load(bytes);
  const n = src.getPageCount();
  const groups = spec?.trim() ? parsePageGroups(spec, n) : Array.from({ length: n }, (_, i) => [i]);
  if (groups.length < 2) throw new PdfOpError('That would give just one file. Use ranges like 1-2, 3-5, or leave pages empty to split every page.');
  const outs: Uint8Array[] = [];
  for (const g of groups) {
    const out = await PDFDocument.create();
    for (const p of await out.copyPages(src, g)) out.addPage(p);
    outs.push(await save(out));
  }
  return outs;
}

export async function deletePages(bytes: Uint8Array, spec: string): Promise<Uint8Array> {
  const doc = await load(bytes);
  const drop = new Set(parsePageSpec(spec, doc.getPageCount()));
  if (drop.size >= doc.getPageCount()) throw new PdfOpError('That would delete every page.');
  [...drop].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
  return save(doc);
}

export async function rotate(bytes: Uint8Array, angle: 90 | 180 | 270, spec?: string): Promise<Uint8Array> {
  const doc = await load(bytes);
  for (const i of parsePageSpec(spec, doc.getPageCount())) {
    const page = doc.getPage(i);
    page.setRotation(degrees((page.getRotation().angle + angle) % 360));
  }
  return save(doc);
}

/**
 * The built-in PDF fonts only cover Latin text. Other scripts (Hindi) arrive as an image drawn by the
 * WebView, which shapes Devanagari correctly; pdf-lib cannot (no conjuncts or vowel-sign reordering).
 */
export const LATIN = /^[\x20-\x7e\xa0-\xff]*$/;

/** Where to put a w x h box, rotated by [angle] about its corner, so its centre lands on (cx, cy). */
function centredRotated(cx: number, cy: number, w: number, h: number, angle: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: cx - ((w / 2) * c - (h / 2) * s), y: cy - ((w / 2) * s + (h / 2) * c) };
}

export async function watermark(bytes: Uint8Array, text: string, opacity = 0.18): Promise<Uint8Array> {
  const t = text.trim();
  if (!t) throw new PdfOpError('Type the watermark text.');
  if (!LATIN.test(t)) throw new PdfOpError('Watermark text in this script needs the image path (watermarkImage).');
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    // Sized so the diagonal text spans about 70% of the page diagonal.
    const diag = Math.hypot(width, height);
    const size = Math.min(96, (diag * 0.7) / Math.max(1, font.widthOfTextAtSize(t, 1)));
    const angle = Math.atan2(height, width);
    const w = font.widthOfTextAtSize(t, size);
    // Cap height is about 0.7 of the size; centring on that box puts the text's middle on the page's middle.
    const at = centredRotated(width / 2, height / 2, w, size * 0.7, angle);
    page.drawText(t, {
      ...at,
      size,
      font,
      color: rgb(0.45, 0.45, 0.45),
      opacity,
      rotate: degrees((angle * 180) / Math.PI),
    });
  }
  return save(doc);
}

/** Watermark from a transparent PNG of the text (any script), laid diagonally across every page. */
export async function watermarkImage(bytes: Uint8Array, png: Uint8Array, opacity = 0.18): Promise<Uint8Array> {
  const doc = await load(bytes);
  const img = await doc.embedPng(png);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const angle = Math.atan2(height, width);
    const w = Math.hypot(width, height) * 0.7;
    const h = (img.height / img.width) * w;
    page.drawImage(img, { ...centredRotated(width / 2, height / 2, w, h, angle), width: w, height: h, opacity, rotate: degrees((angle * 180) / Math.PI) });
  }
  return save(doc);
}

export async function addPageNumbers(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const size = 10;
    const { width } = page.getSize();
    page.drawText(label, { x: (width - font.widthOfTextAtSize(label, size)) / 2, y: 18, size, font, color: rgb(0.3, 0.3, 0.3) });
  });
  return save(doc);
}

export interface PdfImage {
  bytes: Uint8Array;
  /** Only JPEG and PNG embed directly; convert others first (see pdfTools.ts). */
  mime: 'image/jpeg' | 'image/png';
  /** Page size in PDF points. Defaults to the image fitted inside A4 (portrait or landscape to match). */
  widthPt?: number;
  heightPt?: number;
}

const A4 = { short: 595.28, long: 841.89 };

/** The image's size scaled to fit A4 in its own orientation; never enlarged past 1 pixel = 1 point. */
export function fitA4(px: { width: number; height: number }): { w: number; h: number } {
  const portrait = px.height >= px.width;
  const boxW = portrait ? A4.short : A4.long;
  const boxH = portrait ? A4.long : A4.short;
  const k = Math.min(boxW / px.width, boxH / px.height, 1);
  return { w: px.width * k, h: px.height * k };
}

/** One image per page, each page sized to its image. */
export async function imagesToPdf(images: PdfImage[]): Promise<Uint8Array> {
  if (images.length === 0) throw new PdfOpError('Pick at least one image.');
  const doc = await PDFDocument.create();
  for (const img of images) {
    const embedded = img.mime === 'image/png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
    const fit = fitA4(embedded);
    const w = img.widthPt ?? fit.w;
    const h = img.heightPt ?? fit.h;
    doc.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h });
  }
  return save(doc);
}

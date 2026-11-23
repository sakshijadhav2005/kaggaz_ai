/*
 * Problems the user can fix (wrong pages, not a PDF, too large). Kept out of pdfOps.ts so the main thread can
 * use them without loading pdf-lib, and free of imports so the worker stays small.
 *
 * An error carries a code and its parameters, not just text: the worker cannot see the app's language, so it
 * sends the code across and the main thread shows it in the user's language (pdfErrorText in src/i18n).
 * The message is the English text, which is also what the assistant's model sees.
 */

export const PDF_ERRORS_EN = {
  encrypted: () => 'This PDF is password-protected, so it cannot be changed.',
  notPdfFile: () => 'This file could not be read as a PDF.',
  badRange: (part: string) => `"${part}" is not a page or range. Use numbers like 1-3, 5.`,
  outOfRange: (part: string, pageCount: number) => `Pages ${part} are outside 1-${pageCount}.`,
  mergeNeedsTwo: () => 'Pick at least two PDFs to merge.',
  splitGivesOne: () => 'That would give just one file. Use ranges like 1-2, 3-5, or leave pages empty to split every page.',
  deletesEverything: () => 'That would delete every page.',
  watermarkEmpty: () => 'Type the watermark text.',
  watermarkNeedsImage: () => 'Watermark text in this script needs the image path (watermarkImage).',
  noImages: () => 'Pick at least one image.',
  noDocument: (id: string) => `No document with id ${id}.`,
  locked: (name: string) => `"${name}" is locked. Unlock it first to use it in a tool.`,
  notPdfDoc: (name: string) => `"${name}" is not a PDF.`,
  notImageDoc: (name: string) => `"${name}" is not an image.`,
  filesTooLarge: () => 'These files are too large to process on the phone (over 80 MB together).',
  fileTooLarge: () => 'This file is too large to compress on the phone (over 80 MB).',
  imagesTooLarge: () => 'These images are too large together (over 80 MB).',
  alreadySmall: (name: string) => `"${name}" is already about as small as it can get.`,
  imageFormat: () => 'This image format cannot be read on this phone. Use JPEG or PNG.',
  workerStopped: (reason: string) => `The PDF worker stopped: ${reason}`,
};

export type PdfErrors = typeof PDF_ERRORS_EN;
export type PdfErrorCode = keyof PdfErrors;
export type PdfErrorParams<K extends PdfErrorCode> = Parameters<PdfErrors[K]>;

export class PdfOpError<K extends PdfErrorCode = PdfErrorCode> extends Error {
  readonly code: K;
  readonly params: PdfErrorParams<K>;

  constructor(code: K, ...params: PdfErrorParams<K>) {
    super((PDF_ERRORS_EN[code] as (...a: unknown[]) => string)(...params));
    this.name = 'PdfOpError';
    this.code = code;
    this.params = params;
  }

  /** The text in another language's table (same codes, same parameters). Unknown codes fall back to English. */
  textIn(table: PdfErrors): string {
    const fn = table[this.code] as ((...a: unknown[]) => string) | undefined;
    return fn ? fn(...this.params) : this.message;
  }
}

export const isPdfErrorCode = (c: unknown): c is PdfErrorCode => typeof c === 'string' && c in PDF_ERRORS_EN;

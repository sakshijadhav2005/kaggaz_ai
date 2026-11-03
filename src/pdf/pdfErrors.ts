/** A problem the user can fix (wrong pages, not a PDF, too large). Its message is shown as is. Kept out of
 * pdfOps.ts so the main thread can use it without loading pdf-lib. */
export class PdfOpError extends Error {}

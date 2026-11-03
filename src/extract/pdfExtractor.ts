import type { Extractor } from '../interfaces';
import type { ExtractedSegment, StoredFile } from '../models';
import type { OcrExtractor } from './ocrExtractor';
import { closePdf, openPdf, pageText, renderPage } from './pdfLib';
import { detectLanguage, textConfidence } from './textUtils';

/** Pages with fewer characters than this are treated as scans and sent to OCR. */
const MIN_TEXT_CHARS = 20;

export class PdfExtractor implements Extractor {
  constructor(
    private read: (file: StoredFile) => Promise<Blob>,
    private ocr: OcrExtractor,
  ) {}

  canHandle = (file: StoredFile) => file.type === 'pdf';

  async extract(file: StoredFile): Promise<ExtractedSegment[]> {
    const doc = await openPdf(await this.read(file));
    const segments: ExtractedSegment[] = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const text = await pageText(doc, n);
        if (text.length >= MIN_TEXT_CHARS) {
          segments.push({ page: n, text, language: detectLanguage(text), confidence: textConfidence(text), method: 'pdf_text' });
        } else {
          segments.push(await this.ocr.recognize(await renderPage(doc, n, 2), 'image/png', n));
        }
      }
    } finally {
      await closePdf(doc);
    }
    return segments;
  }
}

import { blobToBase64 } from '../core/base64';
import type { Extractor, LlmClient } from '../interfaces';
import { mimeFor, type ExtractedSegment, type StoredFile } from '../models';
import type { OcrEngine } from './ocrEngine';
import { detectLanguage, textConfidence } from './textUtils';

const GEMMA_OCR_PROMPT =
  'Transcribe all text visible in this image exactly as written. Do not translate. ' +
  'If unreadable, write [unreadable]. Return only the transcription.';

const canvasToBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));

/**
 * OCR through whichever [OcrEngine] it is given, with a Gemma fallback when the
 * result is weak and we are online.
 */
export class OcrExtractor implements Extractor {
  constructor(
    private read: (file: StoredFile) => Promise<Blob>,
    private isOnline: () => boolean,
    private engine: OcrEngine,
    private llm?: LlmClient,
  ) {}

  canHandle = (file: StoredFile) => file.type === 'image';

  async extract(file: StoredFile) {
    return [await this.recognize(await this.read(file), mimeFor(file.name), 1)];
  }

  async recognize(image: Blob | HTMLCanvasElement, mime: string, page?: number): Promise<ExtractedSegment> {
    const blob = image instanceof Blob ? image : await canvasToBlob(image);
    const deviceText = await this.engine.recognize(blob);
    let seg = this.segment(deviceText, page, 'ocr_device');

    if (seg.confidence < 0.5 && this.llm && this.isOnline()) {
      try {
        const reply = await this.llm.completeWithImage(GEMMA_OCR_PROMPT, await blobToBase64(blob), image instanceof Blob ? mime : 'image/png');
        if (!reply.includes('[unreadable]') && reply.trim().length > deviceText.trim().length) {
          seg = this.segment(reply, page, 'ocr_gemma');
        }
      } catch {
        // Keep the device result.
      }
    }
    return seg;
  }

  private segment(text: string, page: number | undefined, method: ExtractedSegment['method']): ExtractedSegment {
    return { page, text: text.trim(), language: detectLanguage(text), confidence: textConfidence(text), method };
  }
}

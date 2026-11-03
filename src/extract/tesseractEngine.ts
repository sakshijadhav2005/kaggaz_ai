import { createWorker, type Worker } from 'tesseract.js';

import type { OcrEngine } from './ocrEngine';

/** English + Hindi in one pass. Language data downloads on first use. */
export class TesseractEngine implements OcrEngine {
  private worker?: Promise<Worker>;

  async recognize(image: Blob): Promise<string> {
    const worker = await (this.worker ??= createWorker(['eng', 'hin']));
    return (await worker.recognize(image)).data.text;
  }
}

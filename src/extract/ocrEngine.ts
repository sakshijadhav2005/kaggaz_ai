/** Turns an image into text. Engines are swappable: ML Kit on a phone, Tesseract elsewhere. */
export interface OcrEngine {
  recognize(image: Blob): Promise<string>;
}

/** Tries [primary]; if it throws or finds no text, uses [secondary]. */
export class FallbackEngine implements OcrEngine {
  constructor(
    private primary: OcrEngine,
    private secondary: OcrEngine,
  ) {}

  async recognize(image: Blob): Promise<string> {
    try {
      const text = await this.primary.recognize(image);
      if (text.trim() !== '') return text;
    } catch {
      // Plugin missing or failed: fall through.
    }
    return this.secondary.recognize(image);
  }
}

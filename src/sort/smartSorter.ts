import type { Classifier } from '../interfaces';
import { SORT_THRESHOLD, type ClassificationResult, type StoredFile } from '../models';

/**
 * Decides the folder only. Moving the file and saving to the DB is the
 * caller's job, so this stays easy to test.
 */
export class SmartSorter {
  constructor(
    private rules: Classifier,
    /** True when some Gemma 4 can answer: hosted when online, or the one on the device. */
    private canUseGemma: () => boolean,
    private gemma?: Classifier,
  ) {}

  async decide(file: StoredFile, text: string): Promise<ClassificationResult> {
    let result = await this.rules.classify(file, text);
    if (!result && this.gemma && this.canUseGemma()) {
      try {
        result = await this.gemma.classify(file, text);
      } catch {
        // Network or API failure: fall through to Unsorted.
      }
    }
    if (result && result.confidence >= SORT_THRESHOLD && result.folder !== 'Unsorted') return result;
    return { folder: 'Unsorted', confidence: result?.confidence ?? 0, source: result?.source ?? 'rule' };
  }
}

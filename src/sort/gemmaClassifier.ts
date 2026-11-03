import type { Classifier, LlmClient } from '../interfaces';
import { CLASSIFIABLE, type ClassificationResult, type StoredFile } from '../models';

export const buildClassifierPrompt = (text: string) => `Classify this document into exactly one of these folders:
${CLASSIFIABLE.join(', ')}.
Return only JSON: {"folder": "<name>", "confidence": <0.0-1.0>}
If unsure, use "Other" with low confidence. Do not add any other text.

Document text:
${text.slice(0, 2000)}`;

/** Parses the model reply; anything unparseable becomes `Unsorted`. */
export function parseClassifierReply(reply: string): ClassificationResult {
  const failed: ClassificationResult = { folder: 'Unsorted', confidence: 0, source: 'gemma' };
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return failed;
  try {
    const json = JSON.parse(match[0]) as { folder?: unknown; confidence?: unknown };
    const { folder, confidence } = json;
    if (typeof folder !== 'string' || !(CLASSIFIABLE as readonly string[]).includes(folder) || typeof confidence !== 'number') {
      return failed;
    }
    return { folder: folder as ClassificationResult['folder'], confidence: Math.min(1, Math.max(0, confidence)), source: 'gemma' };
  } catch {
    return failed;
  }
}

/** Online second pass, used only when no rule matched. */
export class GemmaClassifier implements Classifier {
  constructor(private llm: LlmClient) {}

  async classify(_file: StoredFile, text: string) {
    if (text.trim() === '') return null;
    return parseClassifierReply(await this.llm.complete(buildClassifierPrompt(text)));
  }
}

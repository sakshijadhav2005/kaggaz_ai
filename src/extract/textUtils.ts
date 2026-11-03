/** 'hi' when Devanagari dominates the letters, otherwise 'en'. */
export function detectLanguage(text: string): string {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return 'en';
  const deva = text.match(/[ऀ-ॿ]/g)?.length ?? 0;
  return deva / letters > 0.3 ? 'hi' : 'en';
}

/** Of several OCR readings of the same image (one per script), the longest one that looks like real text. */
export function pickBestText(texts: string[]): string {
  const score = (t: string) => t.length * textConfidence(t);
  return texts.reduce((best, t) => (score(t) > score(best) ? t : best), texts[0] ?? '');
}

/** Rough 0..1 heuristic: empty or mostly symbols means low. Tune on real photos. */
export function textConfidence(text: string): number {
  const s = text.replace(/\s/g, '');
  if (s.length === 0) return 0;
  if (s.length < 10) return 0.2;
  const good = s.match(/[\p{L}\p{N}\p{M}]/gu)?.length ?? 0;
  return Math.min(1, good / s.length);
}

import type { Chunk } from '../models';

export interface Scored<T> {
  item: T;
  score: number;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Brute-force search; fine at MVP scale. */
export function topK(query: number[], chunks: Chunk[], k: number): Scored<Chunk>[] {
  return chunks
    .filter((c) => c.embedding)
    .map((c) => ({ item: c, score: cosine(query, c.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

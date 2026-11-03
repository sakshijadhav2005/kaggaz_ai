import { keywordTokens } from './folderSearch';

/** One stored chunk plus the file it came from. */
export interface SearchableChunk {
  fileId: string;
  fileName: string;
  folder: string;
  page?: number;
  text: string;
}

export interface SnippetHit {
  fileId: string;
  fileName: string;
  folder: string;
  page?: number;
  snippet: string;
  /** A longer stretch of the chunk around the match, to hand to a model as an excerpt. */
  text: string;
  /** How many query words the passage contains. */
  score: number;
  /** The query words found, for highlighting. */
  matched: string[];
}

/** A word and its singular, so "skills" finds "skill" and the reverse. */
export const variantsOf = (t: string): string[] => (t.length > 3 && t.endsWith('s') ? [t, t.slice(0, -1)] : [t]);

export function makeSnippet(text: string, tokens: string[], width = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const v of tokens.flatMap(variantsOf)) {
    const i = lower.indexOf(v);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 60);
  const end = Math.min(flat.length, start + width);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/**
 * Works offline over every stored chunk. A passage qualifies when it contains at
 * least half of the query words (file name counts too); more matches rank higher.
 */
export function searchSnippets(query: string, chunks: SearchableChunk[], opts: { limit?: number; perFile?: number } = {}): SnippetHit[] {
  const { limit = 8, perFile = 3 } = opts;
  const tokens = keywordTokens(query);
  if (tokens.length === 0) return [];
  const min = Math.max(1, Math.ceil(tokens.length / 2));

  const hits: SnippetHit[] = [];
  for (const c of chunks) {
    const hay = `${c.fileName} ${c.text}`.toLowerCase();
    const matched = tokens.filter((t) => variantsOf(t).some((v) => hay.includes(v)));
    if (matched.length >= min) {
      hits.push({ fileId: c.fileId, fileName: c.fileName, folder: c.folder, page: c.page, snippet: makeSnippet(c.text, matched), text: makeSnippet(c.text, matched, 1500), score: matched.length, matched });
    }
  }
  hits.sort((a, b) => b.score - a.score);

  const perFileCount = new Map<string, number>();
  return hits
    .filter((h) => {
      const n = perFileCount.get(h.fileId) ?? 0;
      perFileCount.set(h.fileId, n + 1);
      return n < perFile;
    })
    .slice(0, limit);
}

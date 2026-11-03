import type { ExtractedSegment } from '../models';

export interface TextChunk {
  text: string;
  page?: number;
  language: string;
}

/**
 * Splits each segment into overlapping chunks. Words stand in for tokens.
 * Never merges across segments (pages).
 */
export function chunkSegments(segments: ExtractedSegment[], size = 400, overlap = 50): TextChunk[] {
  const out: TextChunk[] = [];
  for (const seg of segments) {
    const words = seg.text.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) continue;
    let start = 0;
    for (;;) {
      const end = Math.min(start + size, words.length);
      out.push({ text: words.slice(start, end).join(' '), page: seg.page, language: seg.language });
      if (end >= words.length) break;
      start = end - overlap;
    }
  }
  return out;
}

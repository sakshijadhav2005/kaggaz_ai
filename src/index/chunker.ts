import type { ExtractedSegment } from '../models';

export interface TextChunk {
  text: string;
  page?: number;
  language: string;
}

interface Word {
  word: string;
  /** A line break follows this word in the source text. */
  breaks: boolean;
}

/**
 * Line breaks are kept: OCR puts each field of a card on its own line, and the
 * mobile-number finder relies on that to tell "Mob: 98765 43210" apart from the
 * Aadhaar number printed on the next line.
 */
const joinWords = (words: Word[]) =>
  words.map((w, i) => (i === words.length - 1 ? w.word : w.word + (w.breaks ? '\n' : ' '))).join('');

/**
 * Splits each segment into overlapping chunks. Words stand in for tokens.
 * Never merges across segments (pages).
 */
export function chunkSegments(segments: ExtractedSegment[], size = 400, overlap = 50): TextChunk[] {
  const out: TextChunk[] = [];
  for (const seg of segments) {
    const words: Word[] = [...seg.text.matchAll(/(\S+)(\s*)/g)].map((m) => ({ word: m[1], breaks: m[2].includes('\n') }));
    if (words.length === 0) continue;
    let start = 0;
    for (;;) {
      const end = Math.min(start + size, words.length);
      out.push({ text: joinWords(words.slice(start, end)), page: seg.page, language: seg.language });
      if (end >= words.length) break;
      start = end - overlap;
    }
  }
  return out;
}

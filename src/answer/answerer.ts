import { topK } from '../index/vector';
import type { EmbeddingProvider, LlmClient } from '../interfaces';
import type { Chunk, StoredFile } from '../models';

export const NOT_FOUND = "I couldn't find this in your files.";

/** One copy of the answer prompt, used everywhere. */
export const ANSWER_PROMPT =
  'Answer only from the excerpts below. Cite excerpt IDs in square brackets. ' +
  'Answer in the language of the question. If the answer is not in the excerpts, say ' +
  `"${NOT_FOUND}" Never invent numbers or dates.`;

/**
 * Used only when nothing in the user's files matches. The reply is shown labelled as
 * "not from your files", and questions about the user's own data are refused, not guessed.
 */
export const buildGeneralPrompt = (question: string) =>
  'The user asked a question that their saved documents do not cover. Answer helpfully and briefly ' +
  'from general knowledge, in the language of the question. If the question is about the user\'s own ' +
  'documents or personal data (their bills, ID numbers, resume, marks, etc.), do not guess: say you ' +
  `do not have that information.\n\nQuestion: ${question}`;

/** Tune on real data; depends on the embedding model. */
export const MIN_SCORE = 0.5;
export const TOP_K = 6;

/** A piece of a file offered to the model as an excerpt. */
export interface Passage {
  fileId: string;
  page?: number;
  text: string;
}

const OFFLINE_PASSAGES = 3;

export interface Citation {
  fileId: string;
  fileName: string;
  folder: string;
  page?: number;
}

export interface Answer {
  text: string;
  citations: Citation[];
}

/** What the answerer needs from storage; keeps it testable. */
export interface AnswerSource {
  chunksWithEmbeddings(): Promise<Chunk[]>;
  getFile(id: string): Promise<StoredFile | undefined>;
}

export function buildAnswerPrompt(question: string, excerpts: string[]): string {
  const body = excerpts.map((e, i) => `[${i + 1}] ${e}`).join('\n\n');
  return `${ANSWER_PROMPT}\n\nExcerpts:\n${body}\n\nQuestion: ${question}`;
}

/** Excerpt IDs the model cited, in order, without duplicates. Handles `[1]` and `[1, 2]`. */
export function citedIds(reply: string): number[] {
  const ids: number[] = [];
  for (const m of reply.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of m[1].split(',')) {
      const id = Number(part.trim());
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export class Answerer {
  constructor(
    private source: AnswerSource,
    private embedder: EmbeddingProvider,
    private llm: LlmClient,
  ) {}

  /** Embedding retrieval, then an answer. Needs the network for the embedding. */
  async ask(question: string): Promise<Answer> {
    const qv = await this.embedder.embed(question);
    const top = topK(qv, await this.source.chunksWithEmbeddings(), TOP_K);
    if (top.length === 0 || top[0].score < MIN_SCORE) return { text: NOT_FOUND, citations: [] };
    return this.answerFrom(question, top.map((s) => s.item));
  }

  /**
   * Answer from passages found by plain word matching, so it works with no network.
   * Few and short on purpose: the on-device model has a small context window.
   */
  askFromPassages(question: string, passages: Passage[]): Promise<Answer> {
    return this.answerFrom(question, passages.slice(0, OFFLINE_PASSAGES));
  }

  private async answerFrom(question: string, items: Passage[]): Promise<Answer> {
    const reply = (await this.llm.complete(buildAnswerPrompt(question, items.map((p) => p.text)))).trim();

    // The app, not the model, supplies file names and pages.
    const citations: Citation[] = [];
    for (const id of citedIds(reply)) {
      if (id < 1 || id > items.length) continue;
      const p = items[id - 1];
      if (citations.some((c) => c.fileId === p.fileId && c.page === p.page)) continue;
      const file = await this.source.getFile(p.fileId);
      if (file) citations.push({ fileId: file.id, fileName: file.name, folder: file.folder, page: p.page });
    }
    return { text: reply, citations };
  }
}

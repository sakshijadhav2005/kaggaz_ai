import { topK } from '../index/vector';
import type { EmbeddingProvider, LlmClient } from '../interfaces';
import type { Chunk, StoredFile } from '../models';
import { tokenize } from '../search/folderSearch';

export const NOT_FOUND = "I couldn't find this in your files.";

/** One copy of the answer prompt, used everywhere. */
export const ANSWER_PROMPT =
  'Answer only from the excerpts below. Give only the requested fact in one brief sentence; do not summarize the full document unless asked. Cite excerpt IDs in square brackets. ' +
  'Answer in the language of the question. If the answer is not in the excerpts, say ' +
  `"${NOT_FOUND}" Never invent numbers or dates.`;

const MOBILE_WORDS = new Set(['mobile', 'cell', 'cellular', 'phone', 'telephone', 'मोबाइल', 'मोबाईल', 'फोन', 'फ़ोन']);
const CONTACT_WORDS = new Set(['contact', 'संपर्क']);
const NUMBER_WORDS = new Set(['number', 'no', 'num', 'नंबर', 'नम्बर']);
const MOBILE_QUERY_WORDS = new Set([
  ...MOBILE_WORDS, ...CONTACT_WORDS, ...NUMBER_WORDS,
  'what', 'whats', 'is', 'the', 'of', 'for', 'in', 'on', 'from', 'my', 'his', 'her', 'their',
  'person', 'particular', 'specific', 'individual', 'someone', 'anyone', 'customer', 'employee', 'applicant',
  'please', 'tell', 'me', 'find', 'give', 'show', 'get', 'document', 'file', 'resume', 'card', 'mobile',
  'phone', 'named', 'called', 'with', 'whose', 'name',
  'aadhaar', 'aadhar', 'uidai', 'pan', 'bill', 'receipt', 'invoice', 'medical', 'study', 'notes',
  'pdf', 'cv', 'identity', 'attached', 'mr', 'mrs', 'ms', 'dr',
  'क्या', 'है', 'का', 'की', 'के', 'मेरा', 'मेरी', 'उसका', 'उसकी', 'बताएं', 'दस्तावेज़', 'इस', 'उस', 'व्यक्ति',
]);
const MOBILE_LABEL = /(?:mobile|cell(?:ular)?|phone|telephone|contact|मोबाइल|मोबाईल|फोन|फ़ोन|संपर्क)/i;
const MOBILE_NUMBER_PATTERN = /(^|[^\d])((?:(?:\+?91|0)[\s-]?)?[6-9](?:[\s-]?\d){9})(?![\s-]?\d)/g;

export function isMobileNumberQuestion(question: string): boolean {
  const words = new Set(tokenize(question));
  return [...MOBILE_WORDS].some((word) => words.has(word)) ||
    ([...CONTACT_WORDS].some((word) => words.has(word)) && [...NUMBER_WORDS].some((word) => words.has(word)));
}

export function mobileNumberSubject(question: string): string {
  return tokenize(question).filter((word) => word.length > 1 && !MOBILE_QUERY_WORDS.has(word)).join(' ');
}

/** Returns the matching mobile number and passage index, or null if none is safely attributable. */
export function findMobileNumber(
  question: string,
  passages: ReadonlyArray<Pick<Passage, 'text'>>,
): { number: string; passageIndex: number } | null {
  const subject = mobileNumberSubject(question).split(' ').filter(Boolean);

  for (const [passageIndex, passage] of passages.entries()) {
    for (const match of passage.text.matchAll(MOBILE_NUMBER_PATTERN)) {
      if (match.index === undefined) continue;
      const candidate = match[2];
      const digits = candidate.replace(/\D/g, '');
      const number = digits.length === 12 && digits.startsWith('91')
        ? digits.slice(2)
        : digits.length === 11 && digits.startsWith('0')
          ? digits.slice(1)
          : digits;
      if (number.length !== 10) continue;

      const start = Math.max(0, match.index - 120);
      const end = Math.min(passage.text.length, match.index + match[0].length + 120);
      const context = passage.text.slice(start, end);
      const contextWords = new Set(tokenize(context));
      if (subject.length > 0 && !subject.every((word) => contextWords.has(word))) continue;
      if (subject.length === 0 && !MOBILE_LABEL.test(context)) continue;
      return { number, passageIndex };
    }
  }
  return null;
}

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

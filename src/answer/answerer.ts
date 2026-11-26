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
const NUMBER_WORDS = new Set(['number', 'numbers', 'no', 'num', 'नंबर', 'नम्बर']);
const MOBILE_QUERY_WORDS = new Set([
  ...MOBILE_WORDS, ...CONTACT_WORDS, ...NUMBER_WORDS,
  'what', 'whats', 'is', 'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'from', 'my', 'his', 'her', 'their',
  'this', 'that', 'it', 'its', 'there', 'which', 'are', 'was', 'and', 'to', 'i', 'can', 'you',
  'person', 'particular', 'specific', 'individual', 'someone', 'anyone', 'customer', 'employee', 'applicant',
  'please', 'tell', 'me', 'find', 'give', 'show', 'get', 'fetch', 'extract', 'read', 'check', 'search', 'want',
  'document', 'documents', 'file', 'files', 'resume', 'card', 'cards', 'mobile', 'mob',
  'phone', 'named', 'called', 'with', 'whose', 'name', 'details', 'detail', 'info', 'information',
  'present', 'written', 'mentioned', 'printed', 'given', 'available', 'saved', 'stored', 'inside',
  'upload', 'uploaded', 'added', 'pic', 'pics', 'picture', 'photo', 'image', 'img', 'scan', 'scanned', 'copy',
  'aadhaar', 'aadhar', 'adhar', 'adhaar', 'aadar', 'uidai', 'uid', 'pan', 'voter', 'license',
  'licence', 'driving', 'passport', 'ration', 'id', 'bill', 'receipt', 'invoice', 'medical', 'study', 'notes',
  'pdf', 'cv', 'identity', 'attached', 'mr', 'mrs', 'ms', 'dr',
  'क्या', 'है', 'का', 'की', 'के', 'में', 'पर', 'मेरा', 'मेरी', 'उसका', 'उसकी', 'बताएं', 'बताओ', 'दस्तावेज़',
  'इस', 'उस', 'व्यक्ति', 'आधार', 'कार्ड', 'फोटो',
]);
/** Labels printed next to a mobile number, including the short forms found on ID cards ("Mob:", "Ph:", "M. No."). */
const MOBILE_LABEL = /(?:mobile|\bmob\b|cell(?:ular)?|phone|\bph\b|\btel\b|telephone|contact|\bm\.?\s?no\b|मोबाइल|मोबाईल|फोन|फ़ोन|संपर्क)/i;
/** Separators stay on one line: OCR puts the next field (often the Aadhaar number) on the next line. */
const MOBILE_NUMBER_PATTERN = /(^|[^\d])((?:(?:\+?91|0)[ \t-]?)?[6-9](?:[ \t-]?\d){9})(?![ \t-]?\d)/g;

export function isMobileNumberQuestion(question: string): boolean {
  const words = new Set(tokenize(question));
  return [...MOBILE_WORDS].some((word) => words.has(word)) ||
    ([...CONTACT_WORDS].some((word) => words.has(word)) && [...NUMBER_WORDS].some((word) => words.has(word)));
}

export function mobileNumberSubject(question: string): string {
  return tokenize(question).filter((word) => word.length > 1 && !MOBILE_QUERY_WORDS.has(word)).join(' ');
}

interface MobileCandidate {
  number: string;
  /** Text around the number. */
  context: string;
  /** Text just before the number, where a "Mobile:" label would be. */
  before: string;
}

/** Letters OCR often reads in place of digits on printed cards. */
const OCR_DIGITS: Record<string, string> = { O: '0', o: '0', D: '0', I: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2' };

/**
 * Fixes OCR misreads inside numbers ("98765 4321O" -> "98765 43210"). Only a run with no spaces
 * that is mostly real digits (at least two) is changed, so words such as "Mob" or "SOIL" stay as
 * they are. Every replacement is one character for one, so positions in the text do not move.
 */
export function fixOcrDigits(text: string): string {
  return text.replace(/[\dODIl|SBZo]+/g, (run) => {
    const digits = run.replace(/\D/g, '').length;
    return digits >= 2 && digits > run.length - digits ? run.replace(/[ODIl|SBZo]/g, (c) => OCR_DIGITS[c]) : run;
  });
}

function mobileCandidates(text: string): MobileCandidate[] {
  const out: MobileCandidate[] = [];
  // Match on the repaired text; context comes from the original (same positions) for name matching.
  for (const match of fixOcrDigits(text).matchAll(MOBILE_NUMBER_PATTERN)) {
    if (match.index === undefined) continue;
    const digits = match[2].replace(/\D/g, '');
    const number = digits.length === 12 && digits.startsWith('91')
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith('0')
        ? digits.slice(1)
        : digits;
    if (number.length !== 10) continue;
    const end = match.index + match[0].length;
    out.push({
      number,
      context: text.slice(Math.max(0, match.index - 120), Math.min(text.length, end + 120)),
      before: text.slice(Math.max(0, match.index - 30), end),
    });
  }
  return out;
}

/**
 * Returns the matching mobile number and passage index, or null if none is safely attributable.
 *
 * With a person's name in the question, a number qualifies when the name is printed near it, or
 * (for ID cards, where the address sits between the name at the top and the number at the bottom)
 * when the name is anywhere in the passage or file name, the number carries a mobile label, and it
 * is the only mobile number in that passage, so a list of contacts never yields someone else's.
 */
export function findMobileNumber(
  question: string,
  passages: ReadonlyArray<Pick<Passage, 'text'> & { fileName?: string }>,
): { number: string; passageIndex: number } | null {
  const subject = mobileNumberSubject(question).split(' ').filter(Boolean);
  const hasSubject = (text: string) => {
    const words = new Set(tokenize(text));
    return subject.every((word) => words.has(word));
  };
  const found = passages.map((p) => mobileCandidates(p.text));

  for (const [passageIndex, candidates] of found.entries()) {
    for (const c of candidates) {
      if (subject.length > 0 ? hasSubject(c.context) : MOBILE_LABEL.test(c.context)) {
        return { number: c.number, passageIndex };
      }
    }
  }

  if (subject.length === 0) return null;
  for (const [passageIndex, candidates] of found.entries()) {
    const passage = passages[passageIndex];
    if (!hasSubject(`${passage.fileName ?? ''} ${passage.text}`)) continue;
    const labelled = candidates.filter((c) => MOBILE_LABEL.test(c.before));
    if (new Set(labelled.map((c) => c.number)).size === 1) return { number: labelled[0].number, passageIndex };
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

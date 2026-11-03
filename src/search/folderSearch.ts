import type { Folder } from '../models';

/**
 * Synonyms that map query (or file name) words to a folder. Defined once and
 * reused by folder search and the filename hint in the rule classifier.
 */
export const FOLDER_SYNONYMS: Partial<Record<Folder, string[]>> = {
  Aadhaar: ['aadhaar', 'aadhar', 'adhar', 'uidai', 'आधार'],
  PAN: ['pan', 'pancard'],
  Bills: ['bill', 'bills', 'electricity'],
  Receipts: ['receipt', 'receipts', 'invoice', 'invoices'],
  Medical: ['medical', 'prescription', 'prescriptions', 'rx'],
  Study: ['study', 'notes'],
};

const QUESTION_STARTS = new Set([
  'what', 'when', 'where', 'why', 'how', 'which', 'who', 'whom', 'whose', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'can', 'could', 'tell', 'kitna', 'kya', 'kab', 'kyun', 'kaun',
  'कितना', 'क्या', 'कब', 'कहाँ', 'क्यों', 'कौन', 'कैसे',
]);

const STOPWORDS = new Set([
  'give', 'me', 'my', 'the', 'a', 'an', 'of', 'for', 'show', 'find', 'get', 'open', 'card', 'file',
  'files', 'please', 'and', 'to', 'in', 'list', 'all', 'from', 'with', 'that', 'this', 'also',
  'tell', 'what', 'whats', 'where', 'when', 'who', 'how', 'which', 'are', 'was', 'were', 'does',
  'did', 'fetch', 'data', 'details', 'into', 'about',
]);

export const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((t) => t !== '');

/** The folder named by [query], or null if no word matches a synonym. */
export function folderForQuery(query: string): Folder | null {
  const tokens = new Set(tokenize(query));
  for (const [folder, words] of Object.entries(FOLDER_SYNONYMS) as [Folder, string[]][]) {
    if (words.some((w) => tokens.has(w))) return folder;
  }
  return null;
}

/** Questions go to Gemma; everything else is a "find my file" request. */
export function isQuestion(query: string): boolean {
  const q = query.trim();
  if (q === '') return false;
  if (q.endsWith('?')) return true;
  const first = tokenize(q)[0];
  return first !== undefined && QUESTION_STARTS.has(first);
}

/** "give me Aadhaar card": name a folder without asking anything, so return the files themselves. */
export const isFileRequest = (query: string): boolean => !isQuestion(query) && folderForQuery(query) !== null;

/** Words worth matching against stored text when no folder matches. */
export const keywordTokens = (query: string): string[] =>
  tokenize(query).filter((t) => t.length > 2 && !STOPWORDS.has(t));

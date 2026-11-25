import { en, type Strings } from '../i18n/en';
import type { SnippetHit } from '../search/snippets';
import { findMobileNumber, isMobileNumberQuestion, mobileNumberSubject, NOT_FOUND, type Answer, type Citation } from './answerer';

export interface ContentSearchDeps {
  online: boolean;
  hasKey: boolean;
  /** Gemma 4 is installed on the device. */
  localReady: boolean;
  /** Retrieval over embeddings, then the hosted model. */
  askHosted(q: string): Promise<Answer>;
  /** Plain word matching over every stored passage. Works offline. */
  findPassages(q: string): Promise<SnippetHit[]>;
  /**
   * Every stored passage. Used when looking up a mobile number, because the card's
   * text often shares no words with the question (an Aadhaar's OCR text rarely says
   * "aadhaar" or "number"), so word matching never offers it.
   */
  allPassages?(): Promise<Array<Pick<SnippetHit, 'fileId' | 'fileName' | 'folder' | 'page' | 'text'>>>;
  /** A written answer from the given passages (uses on-device Gemma 4 when offline). */
  askFromPassages(q: string, hits: SnippetHit[]): Promise<Answer>;
  general(q: string): Promise<string>;
}

export interface ContentResult {
  text: string;
  citations?: Citation[];
  snippets?: SnippetHit[];
}

/**
 * Answers a question about the user's files, in order of quality:
 *   1. hosted Gemma 4 over embedding retrieval (online + key), with citations
 *   2. on-device Gemma 4 over the best matching passages (offline), with citations
 *   3. the matching passages themselves, each naming its file and page
 *   4. a clearly labelled general answer, when nothing in the files matches
 */
/** [m] is the message text in the user's language; English by default. */
export async function searchContent(q: string, d: ContentSearchDeps, m: Strings['search'] = en.search): Promise<ContentResult> {
  if (isMobileNumberQuestion(q)) {
    let passages: Array<Pick<SnippetHit, 'fileId' | 'fileName' | 'folder' | 'page' | 'text'>> = await d.findPassages(q);
    let match = findMobileNumber(q, passages);
    const subject = mobileNumberSubject(q);
    if (!match && subject) {
      passages = await d.findPassages(subject);
      match = findMobileNumber(q, passages);
    }
    if (!match && d.allPassages) {
      // findMobileNumber still requires the person's name, or a mobile label, beside the number.
      passages = await d.allPassages();
      match = findMobileNumber(q, passages);
    }
    if (!match) return { text: m.notFound };
    const source = passages[match.passageIndex];
    return {
      text: m.mobileNumber(match.number),
      citations: [{ fileId: source.fileId, fileName: source.fileName, folder: source.folder, page: source.page }],
    };
  }

  const hostedUsable = d.online && d.hasKey;
  let hosted: 'unavailable' | 'notfound' | 'failed' = 'unavailable';
  let note = '';

  if (hostedUsable) {
    try {
      const a = await d.askHosted(q);
      if (!a.text.includes(NOT_FOUND)) return { text: a.text, citations: a.citations };
      hosted = 'notfound';
    } catch (e) {
      hosted = 'failed';
      note = m.hostedFailed(String(e));
    }
  } else {
    note = d.online ? m.aiOff : m.offline;
  }

  const snippets = await d.findPassages(q);

  if (snippets.length > 0) {
    // The hosted model already said it is not in the files: do not second-guess it with a weaker one.
    if (d.localReady && hosted !== 'notfound') {
      try {
        const a = await d.askFromPassages(q, snippets);
        if (!a.text.includes(NOT_FOUND)) {
          return { text: `${a.text}\n\n${m.onDevice}`, citations: a.citations };
        }
      } catch (e) {
        note = `${note} ${m.localFailed(String(e))}`.trim();
      }
    }
    const tip = !hostedUsable && !d.localReady ? m.getModel : '';
    return { text: [m.found, note, tip].filter(Boolean).join('\n'), snippets };
  }

  // Nothing in the files matches: answer from general knowledge, labelled as such.
  if ((hostedUsable && hosted !== 'failed') || d.localReady) {
    try {
      const reply = await d.general(q);
      if (reply) return { text: `${m.notFound}\n\n${m.general}\n${reply}` };
    } catch {
      // Fall through to the plain "not found".
    }
  }
  return { text: [m.notFound, note].filter(Boolean).join('\n') };
}

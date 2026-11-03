import { NOT_FOUND, type Answer } from '../answer/answerer';

export interface QaCase {
  question: string;
  /** Text the answer must contain; null means the answer must be "not found". */
  expect: string | null;
  /** Part of the file name the citations must include (case-insensitive). */
  file: string | null;
}

export interface QaOutcome {
  testCase: QaCase;
  answer: string;
  passed: boolean;
}

/**
 * Pass = answer has the expected text AND cites the expected file.
 * For unanswerable questions, pass = the app says it couldn't find it.
 */
export function judge(c: QaCase, a: Answer): boolean {
  if (c.expect === null) return a.text.includes(NOT_FOUND);
  if (!a.text.toLowerCase().includes(c.expect.toLowerCase())) return false;
  const f = c.file?.toLowerCase();
  return !f || a.citations.some((x) => x.fileName.toLowerCase().includes(f));
}

export async function runQaEval(cases: QaCase[], ask: (q: string) => Promise<Answer>): Promise<QaOutcome[]> {
  const out: QaOutcome[] = [];
  for (const c of cases) {
    try {
      const a = await ask(c.question);
      out.push({ testCase: c, answer: a.text, passed: judge(c, a) });
    } catch (e) {
      out.push({ testCase: c, answer: `ERROR: ${e}`, passed: false });
    }
  }
  return out;
}

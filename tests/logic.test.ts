import { describe, expect, it } from 'vitest';

import { ANSWER_PROMPT, Answerer, NOT_FOUND, buildAnswerPrompt, buildGeneralPrompt, citedIds, type Answer, type Citation } from '../src/answer/answerer';
import { judge } from '../src/eval/qaEval';
import { OcrExtractor } from '../src/extract/ocrExtractor';
import { FallbackEngine, type OcrEngine } from '../src/extract/ocrEngine';
import { pickBestText } from '../src/extract/textUtils';
import { findMobileNumber, fixOcrDigits, isMobileNumberLookup, isMobileNumberQuestion } from '../src/answer/answerer';
import { chunkSegments } from '../src/index/chunker';
import { topK } from '../src/index/vector';
import type { Classifier } from '../src/interfaces';
import { fileTypeFor, type Chunk, type ClassificationResult, type StoredFile } from '../src/models';
import { isEmptyRecord, parseRecord } from '../src/records/recordParser';
import { folderForQuery, isFileRequest, isQuestion } from '../src/search/folderSearch';
import { searchSnippets } from '../src/search/snippets';
import { parseClassifierReply } from '../src/sort/gemmaClassifier';
import { RuleClassifier, type RuleJson } from '../src/sort/ruleClassifier';
import rulesJson from '../src/sort/rules.json';
import { SmartSorter } from '../src/sort/smartSorter';

const rules = new RuleClassifier(rulesJson as RuleJson[]);

const file = (name: string): StoredFile => ({
  id: '1', name, type: fileTypeFor(name), path: `/x/${name}`, folder: 'Unsorted',
  status: 'ready', source: 'rule', language: 'en', importedAt: 0, text: '',
});

class FakeGemma implements Classifier {
  calls = 0;
  constructor(private result: ClassificationResult | null) {}
  async classify() {
    this.calls++;
    return this.result;
  }
}

describe('folder search', () => {
  it('maps synonyms to folders', () => {
    expect(folderForQuery('give me Aadhaar card')).toBe('Aadhaar');
    expect(folderForQuery('adhar')).toBe('Aadhaar');
    expect(folderForQuery('मेरा आधार दिखाओ')).toBe('Aadhaar');
    expect(folderForQuery('show my pan card')).toBe('PAN');
    expect(folderForQuery('my utility bill')).toBe('Bills');
    expect(folderForQuery('company holiday')).toBeNull(); // "pan" must not match inside words
  });

  it('routes questions to the answerer', () => {
    expect(isQuestion('what was the August bill?')).toBe(true);
    expect(isQuestion('how much did I pay')).toBe(true);
    expect(isQuestion('give me Aadhaar card')).toBe(false);
  });
});

describe('content search (your resume scenario)', () => {
  const resume = {
    fileId: 'r1', fileName: 'Sakshi_Jadhav_Resume.pdf', folder: 'Other', page: 1,
    text: 'Sakshi Jadhav\nEmail: sakshi.jadhav@example.com  Phone: 98765 43210\nEducation: B.Tech\n' +
      'Technical Skills: Python, React, TypeScript, SQL, Docker\nProjects: Kaagaz',
  };
  const bill = { fileId: 'b1', fileName: 'electricity_aug.pdf', folder: 'Bills', page: 1, text: 'Adani Electricity Amount Payable Rs 1,840' };
  const chunks = [resume, bill];

  it('finds the email by name and field', () => {
    const [top] = searchSnippets('sakshi jadhav email id', chunks);
    expect(top.fileName).toBe('Sakshi_Jadhav_Resume.pdf');
    expect(top.page).toBe(1);
    expect(top.snippet).toContain('sakshi.jadhav@example.com');
  });

  it('finds the skills list for a loosely worded request', () => {
    const hits = searchSnippets('my technical skill list', chunks);
    expect(hits.map((h) => h.fileName)).toEqual(['Sakshi_Jadhav_Resume.pdf']);
    expect(hits[0].snippet).toContain('Python, React, TypeScript');
  });

  it('searches across every file and names each source', () => {
    const hits = searchSnippets('electricity amount', chunks);
    expect(hits[0]).toMatchObject({ fileName: 'electricity_aug.pdf', folder: 'Bills' });
  });

  it('returns nothing for text that is not in any file', () => {
    expect(searchSnippets('quantum chromodynamics', chunks)).toEqual([]);
  });

  it('only lists a folder\'s files for plain file requests', () => {
    expect(isFileRequest('give me Aadhaar card')).toBe(true);
    expect(isFileRequest('मुझे आधार कार्ड दिखाओ')).toBe(true);
    expect(isFileRequest('मुझे आधार नंबर बताओ')).toBe(false);
    expect(isFileRequest('download Sakshi Jadhav resume.pdf')).toBe(true);
    expect(isFileRequest('Can you send my resume?')).toBe(true);
    expect(isFileRequest('show me the document')).toBe(true);
    expect(isFileRequest('give me the mobile number of Sakshi Jadhav')).toBe(false);
    expect(isFileRequest('give me Aadhaar number')).toBe(false);
    expect(isFileRequest('sakshi jadhav email id')).toBe(false);
    expect(isFileRequest('what is the pan number?')).toBe(false);
  });
});

describe('rules', () => {
  it('first matching rule wins', () => {
    const r = rules.classifySync('scan.jpg', 'Government of India UIDAI Aadhaar 1234 5678 9012');
    expect(r?.folder).toBe('Aadhaar');
    expect(r?.confidence).toBe(0.9);
  });

  it('recognizes lowercase PAN text and does not treat a generic amount as a bill marker', () => {
    expect(rules.classifySync('scan.jpg', 'Permanent Account Number abcde1234f')?.folder).toBe('PAN');
    expect(rules.classifySync('receipt.jpg', 'Retail receipt. GST 18%. Amount payable Rs 500.')?.folder).toBe('Receipts');
    expect(rules.classifySync('bill.pdf', 'Electricity bill. Units consumed 230. GST 18%.')?.folder).toBe('Bills');
    expect(rules.classifySync('units.jpg', 'Units consumed: 230')?.folder).toBe('Bills');
  });

  it('recognizes a utility bill from its provider and payment details', () => {
    expect(rules.classifySync('scan.jpg', 'Tata Power Amount Payable 100 Due Date 01/01/2099')?.folder).toBe('Bills');
    expect(rules.classifySync('scan.jpg', 'Tata Power account notice with a due date')?.folder).toBeUndefined();
  });

  it('filename is a weak signal', () => {
    const r = rules.classifySync('aadhar_front.jpg', 'blurry nothing');
    expect(r?.folder).toBe('Aadhaar');
    expect(r?.confidence).toBe(0.6);
  });

  it('no match returns null', () => {
    expect(rules.classifySync('photo.jpg', 'hello world')).toBeNull();
  });
});

describe('sorting accuracy (labeled sample)', () => {
  const samples: [string, string, string][] = [
    ['a.jpg', 'Government of India UIDAI Aadhaar 1234 5678 9012', 'Aadhaar'],
    ['b.jpg', 'आधार 1234 5678 9012 भारत सरकार', 'Aadhaar'],
    ['c.jpg', 'Income Tax Department Permanent Account Number ABCDE1234F', 'PAN'],
    ['d.pdf', 'Electricity bill. Units consumed 230. Amount payable Rs 1,840.00. Due date 15/09/2025', 'Bills'],
    ['e.pdf', 'Tax Invoice GST 18% Total amount 5,900', 'Receipts'],
    ['f.jpg', 'Prescription. Dr Rao. Rx Paracetamol 500mg', 'Medical'],
    ['g.pdf', 'Lab report: hemoglobin 13.2 g/dL', 'Medical'],
    ['h.jpg', 'random photo of a cat', 'Unsorted'],
  ];

  it('reports accuracy', async () => {
    const sorter = new SmartSorter(rules, () => false);
    let correct = 0;
    for (const [name, text, expected] of samples) {
      if ((await sorter.decide(file(name), text)).folder === expected) correct++;
    }
    console.log(`Sorting accuracy: ${correct}/${samples.length}`);
    expect(correct).toBe(samples.length);
  });
});

describe('smart sorter', () => {
  it('uses Gemma only when online and no rule matched', async () => {
    const gemma = new FakeGemma({ folder: 'Study', confidence: 0.8, source: 'gemma' });
    const online = new SmartSorter(rules, () => true, gemma);
    expect((await online.decide(file('n.pdf'), 'lecture notes on thermodynamics')).folder).toBe('Study');
    await online.decide(file('d.pdf'), 'Electricity bill. Units consumed 100.');
    expect(gemma.calls).toBe(1);

    const offline = new SmartSorter(rules, () => false, gemma);
    expect((await offline.decide(file('n.pdf'), 'lecture notes')).folder).toBe('Unsorted');
  });

  it('low Gemma confidence goes to Unsorted', async () => {
    const gemma = new FakeGemma({ folder: 'Other', confidence: 0.3, source: 'gemma' });
    const sorter = new SmartSorter(rules, () => true, gemma);
    expect((await sorter.decide(file('x.pdf'), 'something vague')).folder).toBe('Unsorted');
  });

  it('a Gemma failure falls back to Unsorted', async () => {
    const failing: Classifier = { classify: async () => { throw new Error('offline'); } };
    const sorter = new SmartSorter(rules, () => true, failing);
    expect((await sorter.decide(file('x.pdf'), 'something vague')).folder).toBe('Unsorted');
  });

  it('unparseable Gemma reply becomes Unsorted', () => {
    expect(parseClassifierReply('I think it is a bill').folder).toBe('Unsorted');
    expect(parseClassifierReply('{"folder": "Banana", "confidence": 0.9}').folder).toBe('Unsorted');
    expect(parseClassifierReply('```json\n{"folder": "Bills", "confidence": 0.8}\n```')).toMatchObject({ folder: 'Bills', confidence: 0.8 });
  });
});

describe('chunker', () => {
  it('overlaps within a page and never merges across pages', () => {
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ');
    const seg = (page: number, text: string) => ({ page, text, language: 'en', confidence: 1, method: 'pdf_text' as const });
    const chunks = chunkSegments([seg(1, words), seg(2, 'short page')]);
    expect(chunks.filter((c) => c.page === 1)).toHaveLength(3);
    expect(chunks.at(-1)).toMatchObject({ page: 2, text: 'short page' });
    expect(chunks[1].text.startsWith('w350 ')).toBe(true); // 50 words of overlap
  });

  it("keeps line breaks so a card's mobile number is still found after indexing", () => {
    const ocr = 'Government of India\nSakshi Jadhav\nMob: 98765 43210\n4567 8912 3456\nआधार';
    const [chunk] = chunkSegments([{ page: 1, text: ocr, language: 'en', confidence: 1, method: 'ocr_device' }]);
    expect(chunk.text).toBe(ocr);
    expect(findMobileNumber('mobile number on aadhar card', [{ text: chunk.text }])?.number).toBe('9876543210');
    expect(findMobileNumber('mobile number of Sakshi Jadhav', [{ text: chunk.text }])?.number).toBe('9876543210');
    // The excerpt handed to the finder by keyword search keeps the line breaks too.
    const [hit] = searchSnippets('sakshi', [{ fileId: 'f', fileName: 'IMG.jpg', folder: 'Aadhaar', page: 1, text: chunk.text }]);
    expect(findMobileNumber('mobile number of Sakshi Jadhav', [hit])?.number).toBe('9876543210');
    expect(hit.snippet).not.toContain('\n');
  });

  it('reads a mobile number with OCR letter-for-digit mistakes, without touching words', () => {
    expect(fixOcrDigits('Mob: 98765 4321O')).toBe('Mob: 98765 43210');
    expect(fixOcrDigits('Ph: 9S765 432l0')).toBe('Ph: 95765 43210');
    expect(fixOcrDigits('Mob SOIL Bold IS 2O')).toBe('Mob SOIL Bold IS 2O'); // one real digit: too little to go on
    const card = 'Sakshi Jadhav\nMob: 98765 4321O\n4567 8912 3456';
    expect(findMobileNumber('mobile number of Sakshi Jadhav', [{ text: card }])?.number).toBe('9876543210');
    expect(findMobileNumber('mobile number on aadhar card', [{ text: 'Mobile: 9B765 432I0' }])?.number).toBe('9876543210');
  });

  it('reads Hindi digits and a lone unlabelled number, but never guesses between two', () => {
    expect(findMobileNumber('मोबाइल नंबर', [{ text: 'मोबाइल: ९८७६५४३२१०' }])?.number).toBe('9876543210');
    const iconCard = { text: 'Sakshi Jadhav\nDOB 01/01/2000\n9876543210\nPune 411001' };
    expect(findMobileNumber('mobile number on id card', [iconCard])?.number).toBe('9876543210');
    expect(findMobileNumber('mobile number on id card', [iconCard, { text: 'Rahul\n9123456780' }])).toBeNull();
  });

  it('treats "mob number" and "extract mobile number" as number lookups, not commands', () => {
    expect(isMobileNumberQuestion('mob number')).toBe(true);
    expect(isMobileNumberLookup('extract mobile number')).toBe(true);
    expect(isMobileNumberLookup('merge my mobile bill pdfs')).toBe(false);
  });
});

describe('vector search', () => {
  it('ranks by cosine similarity and skips chunks without vectors', () => {
    const chunks: Chunk[] = [
      { fileId: 'a', text: 'a', language: 'en', embedding: [1, 0] },
      { fileId: 'b', text: 'b', language: 'en', embedding: [0, 1] },
      { fileId: 'c', text: 'c', language: 'en' },
    ];
    expect(topK([0.9, 0.1], chunks, 6).map((s) => s.item.fileId)).toEqual(['a', 'b']);
  });
});

describe('records', () => {
  it('parses a bill', () => {
    const r = parseRecord('Adani Electricity\nBill Date: 01/08/2025\nUnits consumed 230\nAmount Payable: Rs. 1,840.50\nDue Date: 15/08/2025');
    expect(r.vendor).toBe('Adani Electricity');
    expect(r.amount).toBe(1840.5);
    expect(r.docDate).toEqual(new Date(2025, 7, 1));
    expect(r.dueDate).toEqual(new Date(2025, 7, 15));
  });

  it('parses written-out dates', () => {
    expect(parseRecord('Due date: 5 Sep 2025').dueDate).toEqual(new Date(2025, 8, 5));
  });

  it('empty text gives an empty record', () => {
    expect(isEmptyRecord(parseRecord(''))).toBe(true);
  });
});

describe('citations', () => {
  it('extracts cited ids in order without duplicates', () => {
    expect(citedIds('Paid Rs 1,840 [2]. Due 15 Aug [1, 2] and [3].')).toEqual([2, 1, 3]);
    expect(citedIds('no citations')).toEqual([]);
  });

  it('prompt numbers the excerpts', () => {
    const p = buildAnswerPrompt('q?', ['first', 'second']);
    expect(p).toContain('[1] first');
    expect(p).toContain('[2] second');
    expect(p).toContain(ANSWER_PROMPT);
    expect(ANSWER_PROMPT).toContain('one brief sentence');
  });
});

describe('answerer', () => {
  const chunks: Chunk[] = [
    { id: 1, fileId: 'f1', text: 'August bill amount payable Rs 1,840', page: 2, language: 'en', embedding: [1, 0] },
    { id: 2, fileId: 'f2', text: 'unrelated', page: 1, language: 'en', embedding: [0, 1] },
  ];
  const source = {
    chunksWithEmbeddings: async () => chunks,
    getFile: async (id: string) => ({ ...file(`${id}.pdf`), id, folder: 'Bills' as const }),
  };
  const embedder = (v: number[]) => ({ embed: async () => v });
  const llm = (reply: string) => ({ complete: async () => reply, completeWithImage: async () => '' });

  it('answers with app-supplied citations', async () => {
    const a = await new Answerer(source, embedder([1, 0]), llm('It was Rs 1,840 [1].')).ask('q');
    expect(a.text).toContain('1,840');
    expect(a.citations).toEqual([{ fileId: 'f1', fileName: 'f1.pdf', folder: 'Bills', page: 2 }]);
  });

  it('ignores citation ids the model invented', async () => {
    const a = await new Answerer(source, embedder([1, 0]), llm('Rs 1,840 [9]')).ask('q');
    expect(a.citations).toEqual([]);
  });

  it('refuses when nothing is similar enough', async () => {
    const a = await new Answerer(source, embedder([-1, -1]), llm('should not be called')).ask('q');
    expect(a).toEqual({ text: NOT_FOUND, citations: [] });
  });
});

describe('general fallback prompt', () => {
  it('asks for a general answer but refuses to guess personal data', () => {
    const p = buildGeneralPrompt('Who wrote Hamlet?');
    expect(p).toContain('Who wrote Hamlet?');
    expect(p).toContain('do not guess');
  });
});

describe('qa eval judge', () => {
  const cite: Citation = { fileId: '1', fileName: 'electricity_aug.pdf', folder: 'Bills', page: 1 };
  const c = { question: 'q', expect: '1,840', file: 'electricity' };
  const none = { question: 'q', expect: null, file: null };
  const ans = (text: string, citations: Citation[] = []): Answer => ({ text, citations });

  it('needs expected text and the right cited file', () => {
    expect(judge(c, ans('It was Rs 1,840 [1]', [cite]))).toBe(true);
    expect(judge(c, ans('It was Rs 1,840'))).toBe(false);
    expect(judge(c, ans('Rs 900 [1]', [cite]))).toBe(false);
  });

  it('unanswerable questions must be refused', () => {
    expect(judge(none, ans(NOT_FOUND))).toBe(true);
    expect(judge(none, ans('Olympus Mons'))).toBe(false);
  });
});

describe('ocr engines', () => {
  const seg = (text: string) => ({ text });
  const engine = (result: string | Error): OcrEngine => ({
    recognize: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const blob = new Blob(['x']);

  it('picks the reading that looks like real text', () => {
    expect(pickBestText(['@@ ## ~~', 'Name: Sakshi Jadhav'])).toBe('Name: Sakshi Jadhav');
    expect(pickBestText([])).toBe('');
  });

  it('falls back when the first engine fails or finds nothing', async () => {
    expect(await new FallbackEngine(engine(new Error('no plugin')), engine('from tesseract')).recognize(blob)).toBe('from tesseract');
    expect(await new FallbackEngine(engine('  '), engine('from tesseract')).recognize(blob)).toBe('from tesseract');
    expect(await new FallbackEngine(engine('from mlkit'), engine('from tesseract')).recognize(blob)).toBe('from mlkit');
    expect(seg('x').text).toBe('x');
  });

  const file = (name: string) => ({ ...({} as StoredFile), name, type: 'image' as const, path: name });

  it('extractor uses the engine and records page, language and method', async () => {
    const ocr = new OcrExtractor(async () => blob, () => false, engine('Email: sakshi@example.com Skills: Python'));
    const [s] = await ocr.extract(file('a.png'));
    expect(s).toMatchObject({ page: 1, method: 'ocr_device', language: 'en' });
    expect(s.text).toContain('sakshi@example.com');
  });

  it('weak OCR falls back to Gemma when online, and ignores [unreadable]', async () => {
    const llm = (reply: string) => ({ complete: async () => '', completeWithImage: async () => reply });
    const weak = engine('~ ~');
    const better = await new OcrExtractor(async () => blob, () => true, weak, llm('Total amount 500 GST invoice')).extract(file('a.png'));
    expect(better[0]).toMatchObject({ method: 'ocr_gemma' });
    const kept = await new OcrExtractor(async () => blob, () => true, weak, llm('[unreadable]')).extract(file('a.png'));
    expect(kept[0]).toMatchObject({ method: 'ocr_device' });
    const offline = await new OcrExtractor(async () => blob, () => false, weak, llm('Total amount 500')).extract(file('a.png'));
    expect(offline[0]).toMatchObject({ method: 'ocr_device' });
  });
});

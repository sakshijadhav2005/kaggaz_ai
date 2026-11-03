import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kaagaz/answer/answerer.dart';
import 'package:kaagaz/eval/qa_eval.dart';
import 'package:kaagaz/index/chunker.dart';
import 'package:kaagaz/index/vector.dart';
import 'package:kaagaz/interfaces.dart';
import 'package:kaagaz/models.dart';
import 'package:kaagaz/records/record_parser.dart';
import 'package:kaagaz/search/folder_search.dart';
import 'package:kaagaz/sort/gemma_classifier.dart';
import 'package:kaagaz/sort/rule_classifier.dart';
import 'package:kaagaz/sort/smart_sorter.dart';

StoredFile _file(String name) => StoredFile(
      id: '1',
      name: name,
      type: fileTypeFor(name),
      path: '/x/$name',
      folder: 'Unsorted',
      status: 'ready',
      source: 'rule',
      language: 'en',
      importedAt: DateTime(2025),
    );

class _FakeGemma implements Classifier {
  _FakeGemma(this.result);
  final ClassificationResult? result;
  int calls = 0;
  @override
  Future<ClassificationResult?> classify(StoredFile file, String text) async {
    calls++;
    return result;
  }
}

void main() {
  final rules = RuleClassifier.fromJson(File('assets/rules.json').readAsStringSync());

  group('folder search', () {
    test('maps synonyms to folders', () {
      expect(folderForQuery('give me Aadhaar card'), 'Aadhaar');
      expect(folderForQuery('adhar'), 'Aadhaar');
      expect(folderForQuery('मेरा आधार दिखाओ'), 'Aadhaar');
      expect(folderForQuery('show my pan card'), 'PAN');
      expect(folderForQuery('company holiday'), isNull); // "pan" must not match inside words
    });

    test('routes questions to the answerer', () {
      expect(isQuestion('what was the August bill?'), isTrue);
      expect(isQuestion('how much did I pay'), isTrue);
      expect(isQuestion('give me Aadhaar card'), isFalse);
    });
  });

  group('rules', () {
    test('first matching rule wins', () {
      final r = rules.classifySync('scan.jpg', 'Government of India UIDAI Aadhaar 1234 5678 9012');
      expect(r?.folder, 'Aadhaar');
      expect(r?.confidence, 0.9);
    });

    test('filename is a weak signal', () {
      final r = rules.classifySync('aadhar_front.jpg', 'blurry nothing');
      expect(r?.folder, 'Aadhaar');
      expect(r?.confidence, 0.6);
    });

    test('no match returns null', () {
      expect(rules.classifySync('photo.jpg', 'hello world'), isNull);
    });
  });

  group('sorting accuracy (labeled sample)', () {
    const samples = <(String, String, String)>[
      ('a.jpg', 'Government of India UIDAI Aadhaar 1234 5678 9012', 'Aadhaar'),
      ('b.jpg', 'आधार 1234 5678 9012 भारत सरकार', 'Aadhaar'),
      ('c.jpg', 'Income Tax Department Permanent Account Number ABCDE1234F', 'PAN'),
      ('d.pdf', 'Electricity bill. Units consumed 230. Amount payable Rs 1,840.00. Due date 15/09/2025', 'Bills'),
      ('e.pdf', 'Tax Invoice GST 18% Total amount 5,900', 'Receipts'),
      ('f.jpg', 'Prescription. Dr Rao. Rx Paracetamol 500mg', 'Medical'),
      ('g.pdf', 'Lab report: hemoglobin 13.2 g/dL', 'Medical'),
      ('h.jpg', 'random photo of a cat', 'Unsorted'),
    ];

    test('reports accuracy', () async {
      final sorter = SmartSorter(rules: rules, isOnline: () async => false);
      var correct = 0;
      for (final (name, text, expected) in samples) {
        final d = await sorter.decide(_file(name), text);
        if (d.folder == expected) correct++;
      }
      // ignore: avoid_print
      print('Sorting accuracy: $correct/${samples.length}');
      expect(correct, samples.length);
    });
  });

  group('smart sorter', () {
    test('uses Gemma only when online and no rule matched', () async {
      final gemma = _FakeGemma(const ClassificationResult(folder: 'Study', confidence: 0.8, source: 'gemma'));
      final online = SmartSorter(rules: rules, gemma: gemma, isOnline: () async => true);
      expect((await online.decide(_file('n.pdf'), 'lecture notes on thermodynamics')).folder, 'Study');
      await online.decide(_file('d.pdf'), 'amount payable 100');
      expect(gemma.calls, 1);

      final offline = SmartSorter(rules: rules, gemma: gemma, isOnline: () async => false);
      expect((await offline.decide(_file('n.pdf'), 'lecture notes')).folder, 'Unsorted');
    });

    test('low Gemma confidence goes to Unsorted', () async {
      final gemma = _FakeGemma(const ClassificationResult(folder: 'Other', confidence: 0.3, source: 'gemma'));
      final sorter = SmartSorter(rules: rules, gemma: gemma, isOnline: () async => true);
      expect((await sorter.decide(_file('x.pdf'), 'something vague')).folder, 'Unsorted');
    });

    test('unparseable Gemma reply becomes Unsorted', () {
      expect(parseClassifierReply('I think it is a bill').folder, 'Unsorted');
      expect(parseClassifierReply('{"folder": "Banana", "confidence": 0.9}').folder, 'Unsorted');
      final ok = parseClassifierReply('```json\n{"folder": "Bills", "confidence": 0.8}\n```');
      expect((ok.folder, ok.confidence), ('Bills', 0.8));
    });
  });

  group('chunker', () {
    test('overlaps within a page and never merges across pages', () {
      final words = List.generate(900, (i) => 'w$i').join(' ');
      final chunks = chunkSegments([
        ExtractedSegment(page: 1, text: words, language: 'en', confidence: 1, method: 'pdf_text'),
        const ExtractedSegment(page: 2, text: 'short page', language: 'en', confidence: 1, method: 'pdf_text'),
      ]);
      expect(chunks.where((c) => c.page == 1).length, 3);
      expect(chunks.last.page, 2);
      expect(chunks.last.text, 'short page');
      // Second chunk starts 50 words before the end of the first.
      expect(chunks[1].text.startsWith('w350 '), isTrue);
    });
  });

  group('vector search', () {
    test('ranks by cosine similarity', () {
      const chunks = [
        Chunk(fileId: 'a', text: 'a', language: 'en', embedding: [1, 0]),
        Chunk(fileId: 'b', text: 'b', language: 'en', embedding: [0, 1]),
        Chunk(fileId: 'c', text: 'c', language: 'en'), // not embedded yet
      ];
      final top = topK([0.9, 0.1], chunks, 6);
      expect(top.map((s) => s.item.fileId), ['a', 'b']);
    });
  });

  group('records', () {
    test('parses a bill', () {
      final r = parseRecord('Adani Electricity\nBill Date: 01/08/2025\nUnits consumed 230\n'
          'Amount Payable: Rs. 1,840.50\nDue Date: 15/08/2025');
      expect(r.vendor, 'Adani Electricity');
      expect(r.amount, 1840.5);
      expect(r.docDate, DateTime(2025, 8, 1));
      expect(r.dueDate, DateTime(2025, 8, 15));
    });

    test('parses written-out dates', () {
      expect(parseRecord('Due date: 5 Sep 2025').dueDate, DateTime(2025, 9, 5));
    });

    test('empty text gives an empty record', () {
      expect(parseRecord('').isEmpty, isTrue);
    });
  });

  group('qa eval judge', () {
    const cite = Citation(fileId: '1', fileName: 'electricity_aug.pdf', folder: 'Bills', page: 1);
    final c = QaCase.fromJson({'question': 'q', 'expect': '1,840', 'file': 'electricity'});
    final none = QaCase.fromJson({'question': 'q', 'expect': null, 'file': null});

    test('needs expected text and the right cited file', () {
      expect(judge(c, const Answer('It was Rs 1,840 [1]', [cite])), isTrue);
      expect(judge(c, const Answer('It was Rs 1,840', [])), isFalse);
      expect(judge(c, const Answer('Rs 900 [1]', [cite])), isFalse);
    });

    test('unanswerable questions must be refused', () {
      expect(judge(none, const Answer(kNotFound, [])), isTrue);
      expect(judge(none, const Answer('Olympus Mons', [])), isFalse);
    });
  });

  group('citations', () {
    test('extracts cited ids in order without duplicates', () {
      expect(citedIds('Paid Rs 1,840 [2]. Due 15 Aug [1, 2] and [3].'), [2, 1, 3]);
      expect(citedIds('no citations'), isEmpty);
    });

    test('prompt numbers the excerpts', () {
      final p = buildAnswerPrompt('q?', ['first', 'second']);
      expect(p, contains('[1] first'));
      expect(p, contains('[2] second'));
      expect(p, contains(kAnswerPrompt));
    });
  });
}

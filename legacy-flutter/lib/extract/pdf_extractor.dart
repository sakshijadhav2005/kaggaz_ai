import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:pdfx/pdfx.dart' as px;
import 'package:syncfusion_flutter_pdf/pdf.dart' as sf;

import '../interfaces.dart';
import '../models.dart';
import 'ocr_extractor.dart';
import 'text_utils.dart';

/// Pages with fewer characters than this are treated as scans and sent to OCR.
const _minTextChars = 20;

class PdfExtractor implements Extractor {
  PdfExtractor(this._ocr);

  final OcrExtractor _ocr;

  @override
  bool canHandle(StoredFile file) => file.type == 'pdf';

  @override
  Future<ExtractionResult> extract(StoredFile file) async {
    final doc = sf.PdfDocument(inputBytes: await File(file.path).readAsBytes());
    final extractor = sf.PdfTextExtractor(doc);
    final texts = [
      for (var i = 0; i < doc.pages.count; i++) extractor.extractText(startPageIndex: i, endPageIndex: i).trim(),
    ];
    doc.dispose();

    final segments = <ExtractedSegment>[];
    px.PdfDocument? renderer;
    try {
      for (var i = 0; i < texts.length; i++) {
        final text = texts[i];
        if (text.length >= _minTextChars) {
          segments.add(ExtractedSegment(
            page: i + 1,
            text: text,
            language: detectLanguage(text),
            confidence: textConfidence(text),
            method: 'pdf_text',
          ));
          continue;
        }
        renderer ??= await px.PdfDocument.openFile(file.path);
        segments.add(await _ocrPage(renderer, i + 1));
      }
    } finally {
      await renderer?.close();
    }
    return ExtractionResult(segments);
  }

  Future<ExtractedSegment> _ocrPage(px.PdfDocument doc, int pageNumber) async {
    final page = await doc.getPage(pageNumber);
    try {
      final img = await page.render(width: page.width * 2, height: page.height * 2, format: px.PdfPageImageFormat.png);
      final tmp = File(p.join(Directory.systemTemp.path, 'kaagaz_ocr_${DateTime.now().microsecondsSinceEpoch}.png'));
      await tmp.writeAsBytes(img!.bytes);
      try {
        return await _ocr.recognize(tmp.path, page: pageNumber);
      } finally {
        await tmp.delete();
      }
    } finally {
      await page.close();
    }
  }
}

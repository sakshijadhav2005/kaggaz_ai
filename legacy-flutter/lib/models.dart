/// Pure Dart data shapes shared by every module (no Flutter imports).

const kFolders = ['Aadhaar', 'PAN', 'Bills', 'Receipts', 'Medical', 'Study', 'Other', 'Unsorted'];

/// Folders a classifier may choose; `Unsorted` is only the fallback.
const kClassifiable = ['Aadhaar', 'PAN', 'Bills', 'Receipts', 'Medical', 'Study', 'Other'];

const kSortThreshold = 0.6;

const kImportExtensions = [
  'pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'mp3', 'm4a', 'wav', 'aac', 'ogg',
];

String fileTypeFor(String name) {
  final ext = name.contains('.') ? name.split('.').last.toLowerCase() : '';
  if (ext == 'pdf') return 'pdf';
  if (const ['jpg', 'jpeg', 'png', 'webp', 'heic'].contains(ext)) return 'image';
  if (const ['mp3', 'm4a', 'wav', 'aac', 'ogg'].contains(ext)) return 'audio';
  return 'other';
}

class StoredFile {
  const StoredFile({
    required this.id,
    required this.name,
    required this.type,
    required this.path,
    required this.folder,
    required this.status,
    required this.source,
    required this.language,
    required this.importedAt,
  });

  final String id, name, type, path, folder;
  final String status; // 'processing' | 'ready' | 'needs_review'
  final String source; // 'rule' | 'gemma' | 'manual'
  final String language;
  final DateTime importedAt;

  StoredFile copyWith({String? path, String? folder, String? status, String? source, String? language}) =>
      StoredFile(
        id: id,
        name: name,
        type: type,
        path: path ?? this.path,
        folder: folder ?? this.folder,
        status: status ?? this.status,
        source: source ?? this.source,
        language: language ?? this.language,
        importedAt: importedAt,
      );

  Map<String, Object?> toMap() => {
        'id': id,
        'name': name,
        'type': type,
        'path': path,
        'folder': folder,
        'status': status,
        'source': source,
        'language': language,
        'imported_at': importedAt.millisecondsSinceEpoch,
      };

  factory StoredFile.fromMap(Map<String, Object?> m) => StoredFile(
        id: m['id'] as String,
        name: m['name'] as String,
        type: m['type'] as String,
        path: m['path'] as String,
        folder: m['folder'] as String,
        status: m['status'] as String,
        source: m['source'] as String,
        language: (m['language'] as String?) ?? 'en',
        importedAt: DateTime.fromMillisecondsSinceEpoch(m['imported_at'] as int),
      );
}

class ExtractedSegment {
  const ExtractedSegment({
    this.page,
    this.startMs,
    required this.text,
    required this.language,
    required this.confidence,
    required this.method,
  });

  final int? page; // PDF and images
  final int? startMs; // audio (later)
  final String text;
  final String language; // 'en', 'hi', ...
  final double confidence;
  final String method; // 'pdf_text' | 'ocr_device' | 'ocr_gemma' | 'manual'
}

class ExtractionResult {
  const ExtractionResult(this.segments);

  static const empty = ExtractionResult([]);

  final List<ExtractedSegment> segments;

  String get fullText => segments.map((s) => s.text).where((t) => t.trim().isNotEmpty).join('\n\n');

  double get confidence =>
      segments.isEmpty ? 0 : segments.map((s) => s.confidence).reduce((a, b) => a + b) / segments.length;

  String get status => fullText.trim().isEmpty || confidence < 0.5 ? 'needs_review' : 'ready';
}

class ClassificationResult {
  const ClassificationResult({required this.folder, required this.confidence, required this.source});

  final String folder; // one of kFolders
  final double confidence;
  final String source; // 'rule' | 'gemma'
}

class Chunk {
  const Chunk({this.id, required this.fileId, required this.text, this.page, required this.language, this.embedding});

  final int? id;
  final String fileId;
  final String text;
  final int? page;
  final String language;
  final List<double>? embedding;
}

class RecordRow {
  const RecordRow({
    required this.fileId,
    required this.fileName,
    required this.kind,
    this.vendor,
    this.amount,
    this.currency = 'INR',
    this.docDate,
    this.dueDate,
  });

  final String fileId, fileName, kind;
  final String? vendor;
  final double? amount;
  final String currency;
  final DateTime? docDate, dueDate;
}

class Reminder {
  const Reminder({required this.id, required this.fileId, required this.title, required this.dueAt, required this.done});

  final int id;
  final String fileId, title;
  final DateTime dueAt;
  final bool done;
}

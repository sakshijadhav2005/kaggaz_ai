import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../models.dart';

Uint8List _encode(List<double> v) => Float32List.fromList(v).buffer.asUint8List();

List<double> _decode(Uint8List bytes) =>
    Uint8List.fromList(bytes).buffer.asFloat32List().toList(growable: false);

DateTime? _date(Object? ms) => ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms as int);

Chunk _chunk(Map<String, Object?> m) => Chunk(
      id: m['id'] as int,
      fileId: m['file_id'] as String,
      text: m['text'] as String,
      page: m['page'] as int?,
      language: (m['language'] as String?) ?? 'en',
      embedding: m['embedding'] == null ? null : _decode(m['embedding'] as Uint8List),
    );

class Db {
  Db._(this._db);

  final Database _db;

  static Future<Db> open() async {
    final db = await openDatabase(
      p.join(await getDatabasesPath(), 'kaagaz.db'),
      version: 1,
      onCreate: (d, _) async {
        // `text` on files holds the full extracted text (used for re-sorting and editing).
        await d.execute('''CREATE TABLE files (
          id TEXT PRIMARY KEY, name TEXT, type TEXT, path TEXT, folder TEXT, status TEXT,
          source TEXT, language TEXT, imported_at INTEGER, text TEXT)''');
        await d.execute('''CREATE TABLE chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT, text TEXT, page INTEGER,
          language TEXT, embedding BLOB)''');
        await d.execute('CREATE INDEX chunks_file ON chunks(file_id)');
        await d.execute('''CREATE TABLE records (
          id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT UNIQUE, kind TEXT, vendor TEXT,
          amount REAL, currency TEXT, doc_date INTEGER, due_date INTEGER)''');
        await d.execute('''CREATE TABLE reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT UNIQUE, title TEXT,
          due_at INTEGER, notified INTEGER DEFAULT 0)''');
      },
    );
    return Db._(db);
  }

  // Files

  Future<void> insertFile(StoredFile f) => _db.insert('files', f.toMap());

  Future<void> updateFile(String id, Map<String, Object?> values) =>
      _db.update('files', values, where: 'id = ?', whereArgs: [id]);

  Future<StoredFile?> getFile(String id) async {
    final rows = await _db.query('files', where: 'id = ?', whereArgs: [id]);
    return rows.isEmpty ? null : StoredFile.fromMap(rows.first);
  }

  Future<List<StoredFile>> files({String? folder}) async {
    final rows = await _db.query(
      'files',
      where: folder == null ? null : 'folder = ?',
      whereArgs: folder == null ? null : [folder],
      orderBy: 'imported_at DESC',
    );
    return rows.map(StoredFile.fromMap).toList();
  }

  Future<Map<String, int>> folderCounts() async {
    final rows = await _db.rawQuery('SELECT folder, COUNT(*) AS c FROM files GROUP BY folder');
    return {for (final r in rows) r['folder'] as String: r['c'] as int};
  }

  Future<String> fileText(String id) async {
    final rows = await _db.query('files', columns: ['text'], where: 'id = ?', whereArgs: [id]);
    return rows.isEmpty ? '' : (rows.first['text'] as String?) ?? '';
  }

  /// Files whose name or any chunk contains every token.
  Future<List<StoredFile>> keywordSearch(List<String> tokens) async {
    if (tokens.isEmpty) return [];
    final where = List.filled(
      tokens.length,
      '(f.name LIKE ? OR EXISTS (SELECT 1 FROM chunks c WHERE c.file_id = f.id AND c.text LIKE ?))',
    ).join(' AND ');
    final args = [for (final t in tokens) ...['%$t%', '%$t%']];
    final rows = await _db.rawQuery('SELECT f.* FROM files f WHERE $where ORDER BY f.imported_at DESC', args);
    return rows.map(StoredFile.fromMap).toList();
  }

  // Chunks

  Future<void> replaceChunks(String fileId, List<Chunk> chunks) => _db.transaction((txn) async {
        await txn.delete('chunks', where: 'file_id = ?', whereArgs: [fileId]);
        final batch = txn.batch();
        for (final c in chunks) {
          batch.insert('chunks', {'file_id': fileId, 'text': c.text, 'page': c.page, 'language': c.language});
        }
        await batch.commit(noResult: true);
      });

  Future<List<Chunk>> chunksMissingEmbedding({int limit = 50}) async =>
      (await _db.query('chunks', where: 'embedding IS NULL', limit: limit)).map(_chunk).toList();

  Future<void> setChunkEmbedding(int id, List<double> v) =>
      _db.update('chunks', {'embedding': _encode(v)}, where: 'id = ?', whereArgs: [id]);

  Future<List<Chunk>> chunksWithEmbeddings() async =>
      (await _db.query('chunks', where: 'embedding IS NOT NULL')).map(_chunk).toList();

  // Records and reminders

  Future<void> saveRecord(String fileId, String kind, {String? vendor, double? amount, DateTime? docDate, DateTime? dueDate}) =>
      _db.insert(
        'records',
        {
          'file_id': fileId,
          'kind': kind,
          'vendor': vendor,
          'amount': amount,
          'currency': 'INR',
          'doc_date': docDate?.millisecondsSinceEpoch,
          'due_date': dueDate?.millisecondsSinceEpoch,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );

  Future<void> deleteRecord(String fileId) => _db.delete('records', where: 'file_id = ?', whereArgs: [fileId]);

  Future<List<RecordRow>> records() async {
    final rows = await _db.rawQuery(
      'SELECT r.*, f.name AS file_name FROM records r JOIN files f ON f.id = r.file_id '
      'ORDER BY COALESCE(r.doc_date, f.imported_at) DESC',
    );
    return [
      for (final r in rows)
        RecordRow(
          fileId: r['file_id'] as String,
          fileName: r['file_name'] as String,
          kind: r['kind'] as String,
          vendor: r['vendor'] as String?,
          amount: (r['amount'] as num?)?.toDouble(),
          currency: (r['currency'] as String?) ?? 'INR',
          docDate: _date(r['doc_date']),
          dueDate: _date(r['due_date']),
        ),
    ];
  }

  Future<int?> reminderIdForFile(String fileId) async {
    final rows = await _db.query('reminders', columns: ['id'], where: 'file_id = ?', whereArgs: [fileId]);
    return rows.isEmpty ? null : rows.first['id'] as int;
  }

  Future<int> saveReminder(String fileId, String title, DateTime dueAt) => _db.insert(
        'reminders',
        {'file_id': fileId, 'title': title, 'due_at': dueAt.millisecondsSinceEpoch, 'notified': 0},
        conflictAlgorithm: ConflictAlgorithm.replace,
      );

  Future<void> deleteReminder(String fileId) => _db.delete('reminders', where: 'file_id = ?', whereArgs: [fileId]);

  Future<List<Reminder>> reminders() async {
    final rows = await _db.query('reminders', orderBy: 'notified ASC, due_at ASC');
    return [
      for (final r in rows)
        Reminder(
          id: r['id'] as int,
          fileId: r['file_id'] as String,
          title: r['title'] as String,
          dueAt: _date(r['due_at'])!,
          done: (r['notified'] as int?) == 1,
        ),
    ];
  }

  Future<void> setReminderDone(int id, bool done) =>
      _db.update('reminders', {'notified': done ? 1 : 0}, where: 'id = ?', whereArgs: [id]);
}

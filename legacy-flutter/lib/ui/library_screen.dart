import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;

import '../eval/qa_eval.dart';
import '../models.dart';
import '../services.dart';
import 'common.dart';

class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key});

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  String? _folder; // null = all
  List<StoredFile> _files = [];
  Map<String, int> _counts = {};
  int _busy = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final files = await services.db.files(folder: _folder);
    final counts = await services.db.folderCounts();
    if (!mounted) return;
    setState(() {
      _files = files;
      _counts = counts;
    });
  }

  Future<void> _import() async {
    final picked = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: FileType.custom,
      allowedExtensions: kImportExtensions,
    );
    if (picked == null) return;
    setState(() => _busy += picked.files.length);
    for (final pf in picked.files) {
      try {
        if (pf.path != null) await services.ingest.importFile(File(pf.path!));
      } catch (e) {
        if (mounted) showError(context, 'Could not import ${pf.name}: $e');
      }
      if (mounted) setState(() => _busy--);
      await _load();
    }
  }

  /// Edit assets/eval_qa.json to match your imported documents, then run.
  Future<void> _runEval() async {
    setState(() => _busy++);
    List<QaOutcome> results;
    try {
      final cases = parseQaCases(await rootBundle.loadString('assets/eval_qa.json'));
      results = await runQaEval(cases, services.answerer.ask);
    } catch (e) {
      if (mounted) showError(context, e);
      return;
    } finally {
      if (mounted) setState(() => _busy--);
    }
    if (!mounted) return;
    final passed = results.where((r) => r.passed).length;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Answer accuracy: $passed/${results.length}'),
        content: SizedBox(
          width: double.maxFinite,
          child: ListView(shrinkWrap: true, children: [
            for (final r in results)
              ListTile(
                dense: true,
                leading: Icon(r.passed ? Icons.check_circle : Icons.cancel, color: r.passed ? Colors.green : Colors.red),
                title: Text(r.testCase.question),
                subtitle: Text(r.answer, maxLines: 3, overflow: TextOverflow.ellipsis),
              ),
          ]),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Close'))],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final total = _counts.values.fold(0, (a, b) => a + b);
    return Scaffold(
      appBar: AppBar(title: const Text('Kaagaz'), actions: [
        IconButton(icon: const Icon(Icons.fact_check_outlined), tooltip: 'Run answer eval', onPressed: _runEval),
      ]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _import,
        icon: const Icon(Icons.add),
        label: const Text('Import'),
      ),
      body: Column(
        children: [
          if (_busy > 0) const LinearProgressIndicator(),
          SizedBox(
            height: 56,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              children: [
                _chip('All', null, total),
                for (final f in kFolders) _chip(f, f, _counts[f] ?? 0),
              ],
            ),
          ),
          Expanded(
            child: _files.isEmpty
                ? const Center(child: Text('No files yet. Tap Import.'))
                : ListView.builder(
                    itemCount: _files.length,
                    itemBuilder: (_, i) => _tile(_files[i]),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _chip(String label, String? folder, int count) => Padding(
        padding: const EdgeInsets.only(right: 8),
        child: ChoiceChip(
          label: Text('$label ($count)'),
          selected: _folder == folder,
          onSelected: (_) {
            setState(() => _folder = folder);
            _load();
          },
        ),
      );

  Widget _tile(StoredFile f) => ListTile(
        leading: Icon(iconForType(f.type)),
        title: Text(f.name, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text(f.status == 'needs_review' ? '${f.folder} · needs review' : f.folder),
        trailing: IconButton(
          icon: const Icon(Icons.drive_file_move_outline),
          tooltip: 'Move',
          onPressed: () async {
            if (await pickFolderAndMove(context, f)) _load();
          },
        ),
        onTap: () async {
          await openFile(context, f);
          // The viewer may have moved or re-sorted the file.
          _load();
        },
      );
}

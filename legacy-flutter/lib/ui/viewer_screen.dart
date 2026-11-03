import 'dart:io';

import 'package:flutter/material.dart';
import 'package:pdfx/pdfx.dart';

import '../models.dart';
import '../services.dart';
import 'common.dart';

class ViewerScreen extends StatefulWidget {
  const ViewerScreen({super.key, required this.file, this.page});

  final StoredFile file;
  final int? page; // 1-based, from a citation

  @override
  State<ViewerScreen> createState() => _ViewerScreenState();
}

class _ViewerScreenState extends State<ViewerScreen> {
  late StoredFile _file = widget.file;
  PdfControllerPinch? _pdf;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    if (_file.type == 'pdf') {
      _pdf = PdfControllerPinch(document: PdfDocument.openFile(_file.path), initialPage: widget.page ?? 1);
    }
  }

  @override
  void dispose() {
    _pdf?.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    final f = await services.db.getFile(_file.id);
    if (f != null && mounted) setState(() => _file = f);
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
      await _reload();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _editText() async {
    final controller = TextEditingController(text: await services.db.fileText(_file.id));
    if (!mounted) return;
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Extracted text'),
        content: SizedBox(
          width: double.maxFinite,
          child: TextField(controller: controller, maxLines: 14, minLines: 6),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
        ],
      ),
    );
    if (saved == true) await _run(() => services.ingest.replaceText(_file, controller.text));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: Text(_file.name, overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(
              icon: const Icon(Icons.drive_file_move_outline),
              tooltip: 'Move',
              onPressed: () async {
                if (await pickFolderAndMove(context, _file)) await _reload();
              },
            ),
            IconButton(icon: const Icon(Icons.edit_note), tooltip: 'View or edit text', onPressed: _editText),
            IconButton(
              icon: const Icon(Icons.refresh),
              tooltip: 'Retry extraction',
              onPressed: () => _run(() => services.ingest.process(_file)),
            ),
          ],
          bottom: _busy
              ? const PreferredSize(preferredSize: Size.fromHeight(4), child: LinearProgressIndicator())
              : null,
        ),
        body: Column(
          children: [
            ListTile(
              dense: true,
              title: Text('Folder: ${_file.folder} (${_file.source})'),
              trailing: _file.status == 'needs_review'
                  ? const Chip(label: Text('Needs review'), avatar: Icon(Icons.warning_amber, size: 18))
                  : null,
            ),
            Expanded(child: _content()),
          ],
        ),
      );

  Widget _content() => switch (_file.type) {
        'pdf' => PdfViewPinch(controller: _pdf!),
        'image' => InteractiveViewer(child: Center(child: Image.file(File(_file.path)))),
        _ => const Center(child: Text('No preview for this file type.')),
      };
}

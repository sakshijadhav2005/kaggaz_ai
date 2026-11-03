import 'package:flutter/material.dart';

import '../models.dart';
import '../services.dart';
import 'viewer_screen.dart';

const _monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String fmtDate(DateTime d) => '${d.day.toString().padLeft(2, '0')} ${_monthNames[d.month - 1]} ${d.year}';

IconData iconForType(String type) => switch (type) {
      'pdf' => Icons.picture_as_pdf_outlined,
      'image' => Icons.image_outlined,
      'audio' => Icons.audiotrack_outlined,
      _ => Icons.insert_drive_file_outlined,
    };

Future<void> openFile(BuildContext context, StoredFile file, {int? page}) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ViewerScreen(file: file, page: page)));

Future<void> openFileById(BuildContext context, String id, {int? page}) async {
  final file = await services.db.getFile(id);
  if (file != null && context.mounted) openFile(context, file, page: page);
}

/// Asks for a folder and moves the file there. Returns true if it moved.
Future<bool> pickFolderAndMove(BuildContext context, StoredFile file) async {
  final folder = await showDialog<String>(
    context: context,
    builder: (ctx) => SimpleDialog(
      title: const Text('Move to folder'),
      children: [
        for (final f in kFolders)
          SimpleDialogOption(
            onPressed: () => Navigator.pop(ctx, f),
            child: Text(f, style: f == file.folder ? const TextStyle(fontWeight: FontWeight.bold) : null),
          ),
      ],
    ),
  );
  if (folder == null || folder == file.folder) return false;
  await services.ingest.moveManually(file, folder);
  return true;
}

void showError(BuildContext context, Object e) =>
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));

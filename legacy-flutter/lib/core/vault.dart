import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../models.dart';

/// App-private folder; each folder in [kFolders] is a subdirectory.
class Vault {
  Vault._(this.root);

  final Directory root;

  static Future<Vault> open() async {
    final docs = await getApplicationDocumentsDirectory();
    final root = Directory(p.join(docs.path, 'vault'));
    for (final f in kFolders) {
      await Directory(p.join(root.path, f)).create(recursive: true);
    }
    return Vault._(root);
  }

  Future<File> store(File src, String id, String folder) =>
      src.copy(p.join(root.path, folder, '${id}_${p.basename(src.path)}'));

  /// Physical move inside the vault. Returns the new path.
  Future<String> move(String path, String folder) async {
    final dest = p.join(root.path, folder, p.basename(path));
    if (dest == path) return path;
    final file = File(path);
    try {
      await file.rename(dest);
    } on FileSystemException {
      await file.copy(dest);
      await file.delete();
    }
    return dest;
  }
}

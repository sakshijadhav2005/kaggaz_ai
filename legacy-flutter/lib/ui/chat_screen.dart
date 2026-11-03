import 'package:flutter/material.dart';

import '../answer/answerer.dart';
import '../models.dart';
import '../search/folder_search.dart';
import '../services.dart';
import 'common.dart';

class _Message {
  _Message.user(this.text)
      : user = true,
        files = const [],
        citations = const [];
  _Message.bot(this.text, {this.files = const [], this.citations = const []}) : user = false;

  final bool user;
  final String text;
  final List<StoredFile> files;
  final List<Citation> citations;
}

// Kept outside the State so history survives tab switches.
final _history = <_Message>[];

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final q = _input.text.trim();
    if (q.isEmpty || _busy) return;
    _input.clear();
    setState(() {
      _history.add(_Message.user(q));
      _busy = true;
    });
    _Message reply;
    try {
      reply = isQuestion(q) ? await _ask(q) : await _find(q);
    } catch (e) {
      reply = _Message.bot('Something went wrong. Answers need an internet connection.\n$e');
    }
    if (!mounted) return;
    setState(() {
      _history.add(reply);
      _busy = false;
    });
  }

  /// Folder match first, then keyword search. Works offline.
  Future<_Message> _find(String q) async {
    final folder = folderForQuery(q);
    var files = folder == null ? <StoredFile>[] : await services.db.files(folder: folder);
    if (files.isEmpty) files = await services.db.keywordSearch(keywordTokens(q));
    if (files.isEmpty) return _Message.bot("I couldn't find a matching file.");
    return _Message.bot('Found ${files.length} file${files.length == 1 ? '' : 's'}:', files: files);
  }

  Future<_Message> _ask(String q) async {
    final a = await services.answerer.ask(q);
    return _Message.bot(a.text, citations: a.citations);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Ask your files')),
        body: Column(
          children: [
            Expanded(
              child: _history.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Text('Try "give me Aadhaar card" or "what was the August bill?"', textAlign: TextAlign.center),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.all(12),
                      itemCount: _history.length,
                      itemBuilder: (_, i) => _bubble(_history[i]),
                    ),
            ),
            if (_busy) const LinearProgressIndicator(),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _input,
                        onSubmitted: (_) => _send(),
                        decoration: const InputDecoration(hintText: 'Find a file or ask a question', border: OutlineInputBorder()),
                      ),
                    ),
                    IconButton(onPressed: _send, icon: const Icon(Icons.send)),
                  ],
                ),
              ),
            ),
          ],
        ),
      );

  Widget _bubble(_Message m) => Align(
        alignment: m.user ? Alignment.centerRight : Alignment.centerLeft,
        child: Card(
          color: m.user ? Theme.of(context).colorScheme.primaryContainer : null,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(m.text),
                for (final f in m.files)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(iconForType(f.type)),
                    title: Text(f.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text(f.folder),
                    onTap: () => openFile(context, f),
                  ),
                if (m.citations.isNotEmpty)
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final c in m.citations)
                        ActionChip(
                          avatar: const Icon(Icons.description_outlined, size: 16),
                          label: Text('${c.fileName} · ${c.folder}${c.page == null ? '' : ' · p.${c.page}'}'),
                          onPressed: () => openFileById(context, c.fileId, page: c.page),
                        ),
                    ],
                  ),
              ],
            ),
          ),
        ),
      );
}

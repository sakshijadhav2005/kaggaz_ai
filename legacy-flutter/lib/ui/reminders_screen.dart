import 'package:flutter/material.dart';

import '../models.dart';
import '../services.dart';
import 'common.dart';

class RemindersScreen extends StatefulWidget {
  const RemindersScreen({super.key});

  @override
  State<RemindersScreen> createState() => _RemindersScreenState();
}

class _RemindersScreenState extends State<RemindersScreen> {
  List<Reminder>? _items;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final items = await services.db.reminders();
    if (mounted) setState(() => _items = items);
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      appBar: AppBar(title: const Text('Reminders')),
      body: items == null
          ? const Center(child: CircularProgressIndicator())
          : items.isEmpty
              ? const Center(child: Text('No reminders. Bills with a due date create one.'))
              : ListView(children: [for (final r in items) _tile(r)]),
    );
  }

  Widget _tile(Reminder r) {
    final overdue = !r.done && r.dueAt.isBefore(DateTime.now());
    return CheckboxListTile(
      value: r.done,
      onChanged: (v) async {
        final done = v ?? false;
        await services.db.setReminderDone(r.id, done);
        try {
          // Completed reminders stop alerting; un-checking a future one re-arms it.
          if (done) {
            await services.scheduler.cancel(r.id);
          } else if (r.dueAt.isAfter(DateTime.now())) {
            await services.scheduler.schedule(r.id, r.title, r.dueAt);
          }
        } catch (_) {}
        _load();
      },
      title: Text(r.title, style: r.done ? const TextStyle(decoration: TextDecoration.lineThrough) : null),
      subtitle: Text(
        '${overdue ? 'Overdue · ' : ''}${fmtDate(r.dueAt)}',
        style: overdue ? TextStyle(color: Theme.of(context).colorScheme.error) : null,
      ),
      secondary: IconButton(icon: const Icon(Icons.open_in_new), onPressed: () => openFileById(context, r.fileId)),
    );
  }
}

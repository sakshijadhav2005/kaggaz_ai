import 'package:flutter/material.dart';

import '../models.dart';
import '../services.dart';
import 'common.dart';

class ExpensesScreen extends StatelessWidget {
  const ExpensesScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Bills and receipts')),
        body: FutureBuilder<List<RecordRow>>(
          future: services.db.records(),
          builder: (context, snap) {
            final rows = snap.data;
            if (rows == null) return const Center(child: CircularProgressIndicator());
            if (rows.isEmpty) return const Center(child: Text('No bills or receipts yet.'));
            final total = rows.fold<double>(0, (sum, r) => sum + (r.amount ?? 0));
            return Column(
              children: [
                ListTile(
                  title: const Text('Total'),
                  trailing: Text('Rs ${total.toStringAsFixed(2)}', style: Theme.of(context).textTheme.titleMedium),
                ),
                const Divider(height: 1),
                Expanded(
                  child: ListView.builder(
                    itemCount: rows.length,
                    itemBuilder: (_, i) => _tile(context, rows[i]),
                  ),
                ),
              ],
            );
          },
        ),
      );

  Widget _tile(BuildContext context, RecordRow r) {
    final parts = [
      r.kind,
      if (r.docDate != null) fmtDate(r.docDate!),
      if (r.dueDate != null) 'due ${fmtDate(r.dueDate!)}',
    ];
    return ListTile(
      title: Text(r.vendor ?? r.fileName),
      subtitle: Text(parts.join(' · ')),
      trailing: Text(r.amount == null ? '-' : 'Rs ${r.amount!.toStringAsFixed(2)}'),
      onTap: () => openFileById(context, r.fileId),
    );
  }
}

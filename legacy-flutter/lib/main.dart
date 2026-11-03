import 'package:flutter/material.dart';

import 'services.dart';
import 'ui/chat_screen.dart';
import 'ui/expenses_screen.dart';
import 'ui/library_screen.dart';
import 'ui/reminders_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Services.init();
  runApp(const KaagazApp());
}

class KaagazApp extends StatelessWidget {
  const KaagazApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Kaagaz',
        theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
        home: const HomeShell(),
      );
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) => Scaffold(
        // Screens reload on tab switch; chat history lives outside its State.
        body: switch (_tab) {
          0 => const LibraryScreen(),
          1 => const ChatScreen(),
          2 => const ExpensesScreen(),
          _ => const RemindersScreen(),
        },
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.folder_outlined), label: 'Library'),
            NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Ask'),
            NavigationDestination(icon: Icon(Icons.receipt_long_outlined), label: 'Expenses'),
            NavigationDestination(icon: Icon(Icons.alarm), label: 'Reminders'),
          ],
        ),
      );
}

import '../models.dart';

/// Synonyms that map query (or file name) words to a folder. Defined once and
/// reused by folder search and the filename hint in the rule classifier.
const folderSynonyms = <String, List<String>>{
  'Aadhaar': ['aadhaar', 'aadhar', 'adhar', 'uidai', 'आधार'],
  'PAN': ['pan', 'pancard'],
  'Bills': ['bill', 'bills', 'electricity'],
  'Receipts': ['receipt', 'receipts', 'invoice', 'invoices'],
  'Medical': ['medical', 'prescription', 'prescriptions', 'rx'],
  'Study': ['study', 'notes'],
};

const _questionStarts = {
  'what', 'when', 'where', 'why', 'how', 'which', 'who', 'whom', 'whose', 'is', 'are', 'was',
  'were', 'do', 'does', 'did', 'can', 'could', 'tell', 'kitna', 'kya', 'kab', 'kyun', 'kaun',
  'कितना', 'क्या', 'कब', 'कहाँ', 'क्यों', 'कौन', 'कैसे',
};

const _stopwords = {
  'give', 'me', 'my', 'the', 'a', 'an', 'of', 'for', 'show', 'find', 'get', 'open', 'card', 'file',
  'files', 'please', 'and', 'to', 'in',
};

final _splitter = RegExp(r'[^\p{L}\p{M}\p{N}]+', unicode: true);

List<String> tokenize(String s) =>
    s.toLowerCase().split(_splitter).where((t) => t.isNotEmpty).toList();

/// Returns the folder named by [query], or null if no word matches a synonym.
String? folderForQuery(String query) {
  final tokens = tokenize(query).toSet();
  for (final entry in folderSynonyms.entries) {
    if (entry.value.any(tokens.contains)) return entry.key;
  }
  return null;
}

/// Questions go to Gemma; everything else is a "find my file" request.
bool isQuestion(String query) {
  final q = query.trim();
  if (q.isEmpty) return false;
  if (q.endsWith('?')) return true;
  final tokens = tokenize(q);
  return tokens.isNotEmpty && _questionStarts.contains(tokens.first);
}

/// Words worth matching against stored text when no folder matches.
List<String> keywordTokens(String query) =>
    tokenize(query).where((t) => t.length > 2 && !_stopwords.contains(t)).toList();

bool isKnownFolder(String name) => kFolders.contains(name);

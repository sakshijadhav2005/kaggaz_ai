import 'dart:math' as math;

class ParsedRecord {
  const ParsedRecord({this.vendor, this.amount, this.docDate, this.dueDate});

  final String? vendor;
  final double? amount;
  final DateTime? docDate, dueDate;

  bool get isEmpty => vendor == null && amount == null && docDate == null && dueDate == null;
}

const _months = {
  'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
  'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
};

const _amountLabels = [
  r'amount\s+payable', r'net\s+payable', r'amount\s+due', r'total\s+due',
  r'grand\s+total', r'total\s+amount', r'\btotal\b',
];
const _dueLabels = [r'due\s*date', r'pay\s*by', r'last\s*date'];
const _docLabels = [r'bill\s*date', r'invoice\s*date', r'date\s+of\s+issue', r'(?<!due\s)\bdate\b'];

DateTime? _mk(int y, int m, int d) => (m < 1 || m > 12 || d < 1 || d > 31) ? null : DateTime(y, m, d);

/// Earliest date in [s]; numeric dates are day-first (dd/mm/yyyy).
DateTime? _firstDate(String s) {
  final numM = RegExp(r'(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})').firstMatch(s);
  final txtM = RegExp(r'(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})\.?,?[\s\-]+(\d{4})').firstMatch(s);
  DateTime? a, b;
  if (numM != null) {
    var y = int.parse(numM.group(3)!);
    if (y < 100) y += 2000;
    a = _mk(y, int.parse(numM.group(2)!), int.parse(numM.group(1)!));
  }
  if (txtM != null) {
    final mon = _months[txtM.group(2)!.substring(0, 3).toLowerCase()] ?? 0;
    b = _mk(int.parse(txtM.group(3)!), mon, int.parse(txtM.group(1)!));
  }
  if (a != null && b != null) return numM!.start <= txtM!.start ? a : b;
  return a ?? b;
}

DateTime? _dateNear(String text, List<String> labels) {
  for (final l in labels) {
    final m = RegExp(l, caseSensitive: false).firstMatch(text);
    if (m == null) continue;
    final d = _firstDate(text.substring(m.end, math.min(text.length, m.end + 40)));
    if (d != null) return d;
  }
  return null;
}

double? _amount(String text) {
  for (final l in _amountLabels) {
    final m = RegExp('$l[^\\d\\n]{0,25}?(\\d[\\d,]*(?:\\.\\d{1,2})?)', caseSensitive: false).firstMatch(text);
    if (m == null) continue;
    final v = double.tryParse(m.group(1)!.replaceAll(',', ''));
    if (v != null) return v;
  }
  return null;
}

String? _vendor(String text) {
  for (final line in text.split('\n')) {
    final t = line.trim();
    if (t.length <= 60 && RegExp(r'\p{L}{3}', unicode: true).hasMatch(t)) return t;
  }
  return null;
}

/// Regex extraction of bill and receipt fields. Currency is assumed INR.
ParsedRecord parseRecord(String text) => ParsedRecord(
      vendor: _vendor(text),
      amount: _amount(text),
      docDate: _dateNear(text, _docLabels),
      dueDate: _dateNear(text, _dueLabels),
    );

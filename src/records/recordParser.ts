/** Regex extraction of bill and receipt fields. Currency is assumed INR. */
export interface ParsedRecord {
  vendor?: string;
  amount?: number;
  docDate?: Date;
  dueDate?: Date;
}

export const isEmptyRecord = (r: ParsedRecord) => !r.vendor && r.amount === undefined && !r.docDate && !r.dueDate;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const AMOUNT_LABELS = [
  'amount\\s+payable', 'net\\s+payable', 'amount\\s+due', 'total\\s+due',
  'grand\\s+total', 'total\\s+amount', '\\btotal\\b',
];
const DUE_LABELS = ['due\\s*date', 'pay\\s*by', 'last\\s*date'];
const DOC_LABELS = ['bill\\s*date', 'invoice\\s*date', 'date\\s+of\\s+issue', '(?<!due\\s)\\bdate\\b'];

const mk = (y: number, m: number, d: number) => (m < 1 || m > 12 || d < 1 || d > 31 ? undefined : new Date(y, m - 1, d));

/** Earliest date in [s]; numeric dates are day-first (dd/mm/yyyy). */
function firstDate(s: string): Date | undefined {
  const numM = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})/.exec(s);
  const txtM = /(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})/.exec(s);
  let a: Date | undefined, b: Date | undefined;
  if (numM) {
    let y = Number(numM[3]);
    if (y < 100) y += 2000;
    a = mk(y, Number(numM[2]), Number(numM[1]));
  }
  if (txtM) b = mk(Number(txtM[3]), MONTHS[txtM[2].slice(0, 3).toLowerCase()] ?? 0, Number(txtM[1]));
  if (a && b) return numM!.index <= txtM!.index ? a : b;
  return a ?? b;
}

function dateNear(text: string, labels: string[]): Date | undefined {
  for (const l of labels) {
    const m = new RegExp(l, 'i').exec(text);
    if (!m) continue;
    const end = m.index + m[0].length;
    const d = firstDate(text.slice(end, end + 40));
    if (d) return d;
  }
  return undefined;
}

function amountOf(text: string): number | undefined {
  for (const l of AMOUNT_LABELS) {
    const m = new RegExp(`${l}[^\\d\\n]{0,25}?(\\d[\\d,]*(?:\\.\\d{1,2})?)`, 'i').exec(text);
    if (!m) continue;
    const v = Number(m[1].replace(/,/g, ''));
    if (!Number.isNaN(v)) return v;
  }
  return undefined;
}

function vendorOf(text: string): string | undefined {
  return text
    .split('\n')
    .map((l) => l.trim())
    .find((t) => t.length <= 60 && /\p{L}{3}/u.test(t));
}

export const parseRecord = (text: string): ParsedRecord => ({
  vendor: vendorOf(text),
  amount: amountOf(text),
  docDate: dateNear(text, DOC_LABELS),
  dueDate: dateNear(text, DUE_LABELS),
});

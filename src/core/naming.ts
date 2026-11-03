/** File-name helpers. The extension is never edited; only the part before it. */

export const MAX_NAME = 80;

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

export function splitName(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  return i > 0 ? { stem: name.slice(0, i), ext: name.slice(i) } : { stem: name, ext: '' };
}

/** Removes characters that are not allowed in file names and trims to a sensible length. */
export function sanitizeStem(s: string): string {
  return s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, MAX_NAME).trim();
}

export const joinName = (stem: string, ext: string) => `${sanitizeStem(stem)}${ext}`;

export const buildNamePrompt = (text: string) => `Suggest a short, descriptive file name for this document (3 to 6 words).
Use the document's own title, person or company, and the kind of document, for example "Adani Electricity Bill August 2025".
Return only the name: no quotes, no file extension, no explanation.

Document text:
${text.slice(0, 1500)}`;

/** Cleans a model reply into a usable name, or null if there is nothing usable. */
export function parseSuggestedName(reply: string): string | null {
  const line = reply
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('```'));
  if (!line) return null;
  const name = sanitizeStem(
    line
      .replace(/^(file\s*name|name|title)\s*[:\-]\s*/i, '')
      .replace(/^["'`*#\s]+|["'`*\s]+$/g, '')
      .replace(/\.(pdf|jpe?g|png|webp|heic)$/i, ''),
  );
  return name.length >= 2 ? name : null;
}

/** No model available: use the first title-like line of the text. */
export function heuristicName(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length <= 60 && /\p{L}{3}/u.test(l));
  return (line && sanitizeStem(line)) || null;
}

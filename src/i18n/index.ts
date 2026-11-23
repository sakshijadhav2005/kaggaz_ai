import { useSyncExternalStore } from 'react';

import { en, type Strings } from './en';
import { hi } from './hi';
import { PdfOpError } from '../pdf/pdfErrors';

/*
 * The app's language. Components call useT() and re-render when it changes; other code calls strings().
 * Chosen in Settings; the first launch follows the phone's language.
 */

export type Lang = 'en' | 'hi';
export type { Strings };

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'हिन्दी' },
];

const DICTS: Record<Lang, Strings> = { en, hi };
const STORE = 'kaagaz.lang';

function initial(): Lang {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved === 'en' || saved === 'hi') return saved;
  } catch {
    // No storage: fall through.
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('hi') ? 'hi' : 'en';
}

let current: Lang = initial();
const subs = new Set<() => void>();

function applyToDocument() {
  if (typeof document !== 'undefined') document.documentElement.lang = current; // screen readers pick the voice from this
}
applyToDocument();

export const lang = () => current;
export const strings = (): Strings => DICTS[current];
/** For dates and numbers. */
export const locale = () => (current === 'hi' ? 'hi-IN' : 'en-IN');

export function setLang(l: Lang) {
  current = l;
  try {
    localStorage.setItem(STORE, l);
  } catch {
    // Applies for this session only.
  }
  applyToDocument();
  subs.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};

/** The current strings; the component re-renders when the language changes. */
export function useT(): Strings {
  useSyncExternalStore(subscribe, lang, lang);
  return DICTS[current];
}

/** An error's text for the screen: PDF tool errors in the app's language, anything else as it is. */
export function errorText(e: unknown): string {
  if (e instanceof PdfOpError) return e.textIn(strings().pdfErrors);
  return e instanceof Error ? e.message : String(e);
}

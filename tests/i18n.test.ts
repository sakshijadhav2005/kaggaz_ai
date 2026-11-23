import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { searchContent, type ContentSearchDeps } from '../src/answer/contentSearch';
import { en } from '../src/i18n/en';
import { hi } from '../src/i18n/hi';
import { memoryStorage } from './helpers';

/** Every leaf as [path, value], with functions called on sample arguments. */
function leaves(o: unknown, path = ''): [string, string][] {
  if (typeof o === 'string') return [[path, o]];
  if (typeof o === 'function') return [[path, String((o as (...a: unknown[]) => unknown)(3, 2, 'X'))]];
  if (Array.isArray(o)) return o.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

/** Strings that are the same in both languages on purpose. */
const SAME_ON_PURPOSE = new Set(['tools.half', 'tools.watermarkPlaceholder', 'settings.devKey']);
const DEVANAGARI = /[ऀ-ॿ]/;

describe('translations', () => {
  it('Hindi has exactly the English keys', () => {
    expect(leaves(hi).map(([p]) => p)).toEqual(leaves(en).map(([p]) => p));
  });

  it('every Hindi string is translated, not copied', () => {
    const enMap = new Map(leaves(en));
    const untranslated = leaves(hi).filter(([p, v]) => !SAME_ON_PURPOSE.has(p) && (v === enMap.get(p) || !DEVANAGARI.test(v)));
    expect(untranslated).toEqual([]);
  });

  it('no string is empty or shows "undefined"', () => {
    for (const [p, v] of [...leaves(en), ...leaves(hi)]) {
      expect(v.trim(), p).not.toBe('');
      expect(v, p).not.toContain('undefined');
    }
  });
});

describe('language switch', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('remembers the choice and serves the right strings', async () => {
    const i18n = await import('../src/i18n');
    i18n.setLang('hi');
    expect(i18n.strings().tabs.library).toBe('लाइब्रेरी');
    expect(i18n.locale()).toBe('hi-IN');
    expect(localStorage.getItem('kaagaz.lang')).toBe('hi');

    vi.resetModules();
    const again = await import('../src/i18n');
    expect(again.lang()).toBe('hi'); // survives a restart
    again.setLang('en');
    expect(again.strings().tabs.library).toBe('Library');
  });

  it('shows PDF tool errors in the chosen language', async () => {
    const i18n = await import('../src/i18n');
    const { PdfOpError } = await import('../src/pdf/pdfErrors');
    const err = new PdfOpError('locked', 'PAN.pdf');
    i18n.setLang('hi');
    expect(i18n.errorText(err)).toBe('"PAN.pdf" लॉक है। टूल में इस्तेमाल करने से पहले इसे अनलॉक करें।');
    i18n.setLang('en');
    expect(i18n.errorText(err)).toBe('"PAN.pdf" is locked. Unlock it first to use it in a tool.');
    expect(i18n.errorText(new Error('plain'))).toBe('plain');
  });

  it('answers in Hindi when the app is in Hindi', async () => {
    const deps: ContentSearchDeps = {
      online: false,
      hasKey: false,
      localReady: false,
      askHosted: async () => ({ text: '', citations: [] }),
      findPassages: async () => [],
      askFromPassages: async () => ({ text: '', citations: [] }),
      general: async () => '',
    };
    const r = await searchContent('क्या', deps, hi.search);
    expect(r.text).toBe(`${hi.search.notFound}\n${hi.search.offline}`);
  });
});

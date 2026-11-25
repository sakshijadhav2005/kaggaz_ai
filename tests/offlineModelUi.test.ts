import { mkdirSync, writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { LocalModelView } from '../src/llm/localModel';
import OfflineModel from '../src/ui/OfflineModel';

const model = (over: Partial<Record<'supported' | 'installed' | 'percent' | 'error' | 'loadError' | 'pause', unknown>> = {}): LocalModelView => ({
  isSupported: () => (over.supported ?? true) as boolean,
  isInstalled: () => (over.installed ?? false) as boolean,
  downloadPercent: () => (over.percent ?? null) as number | null,
  lastError: () => (over.error ?? '') as string,
  downloadPause: () => (over.pause ?? '') as string,
  loadError: () => (over.loadError ?? '') as string,
  retryLoad: async () => undefined,
  redownload: async () => undefined,
  subscribe: () => () => undefined,
  download: async () => undefined,
});

const html = (m: LocalModelView, variant: 'banner' | 'panel') => renderToStaticMarkup(createElement(OfflineModel, { model: m, variant }));

const STATES = {
  'not-installed': model(),
  downloading: model({ percent: 37 }),
  installed: model({ installed: true }),
  failed: model({ error: 'HTTP 401: sign in to Hugging Face' }),
  'wont-start': model({ installed: true, loadError: 'Failed to load model: out of memory. This phone may not have enough free memory.' }),
};

describe('Gemma 4 download card (Ask tab banner)', () => {
  it('offers the download, with the size, when it is not on the phone', () => {
    const h = html(STATES['not-installed'], 'banner');
    expect(h).toContain('Answer offline with Gemma 4');
    expect(h).toContain('Download Gemma 4 (2.6 GB)');
    expect(h).toContain('Wi-Fi');
  });

  it('shows live progress while downloading, and no second download button', () => {
    const h = html(STATES.downloading, 'banner');
    expect(h).toContain('Downloading Gemma 4… 37%');
    expect(h).toContain('value="37"');
    expect(h).not.toContain('<button');
  });

  it('turns into a small confirmation once installed', () => {
    const h = html(STATES.installed, 'banner');
    expect(h).toContain('Gemma 4 is on this phone');
    expect(h).not.toContain('<button');
  });

  it('shows why a download failed and lets you retry', () => {
    const h = html(STATES.failed, 'banner');
    expect(h).toContain('Download failed: HTTP 401');
    expect(h).toContain('Download Gemma 4');
  });

  it('when downloaded but it will not start: says why, and retries without downloading again', () => {
    const h = html(STATES['wont-start'], 'banner');
    expect(h).toContain('downloaded but could not start');
    expect(h).toContain('out of memory');
    expect(h).toContain('Try again');
    expect(h).toContain('Download again');
    expect(h).not.toContain('Gemma 4 is on this phone'); // not shown as ready
    expect(h).not.toContain('Download Gemma 4 (2.6 GB)');
  });

  it('shows nothing in a browser, where the model cannot run', () => {
    expect(html(model({ supported: false }), 'banner')).toBe('');
  });
});

describe('Gemma 4 section in Settings', () => {
  it('explains where it runs when in a browser', () => {
    expect(html(model({ supported: false }), 'panel')).toContain('Android app');
  });

  it('has the same download button', () => {
    expect(html(STATES['not-installed'], 'panel')).toContain('Download Gemma 4 (2.6 GB)');
    expect(html(STATES.installed, 'panel')).toContain('is on this device');
  });
});

// `PREVIEW_DIR=some/folder npm test` also writes each state as an HTML snippet, to look at with the real stylesheet.
describe.skipIf(!process.env.PREVIEW_DIR)('preview export', () => {
  it('writes the states', () => {
    mkdirSync(process.env.PREVIEW_DIR!, { recursive: true });
    for (const [name, m] of Object.entries(STATES)) writeFileSync(`${process.env.PREVIEW_DIR}/${name}.html`, html(m, 'banner'));
  });
});

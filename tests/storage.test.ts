import { describe, expect, it } from 'vitest';

import { summarizeStorage } from '../src/core/storage';

describe('storage summary', () => {
  it('reports zero usage when the vault is empty', () => {
    expect(summarizeStorage([])).toEqual({ fileCount: 0, bytesUsed: 0, pdfCount: 0, pdfBytesUsed: 0 });
  });

  it('counts uploaded files and PDF usage separately', () => {
    expect(summarizeStorage([
      { type: 'pdf', bytes: 1200 },
      { type: 'image', bytes: 800 },
      { type: 'pdf', bytes: 400 },
    ])).toEqual({ fileCount: 3, bytesUsed: 2400, pdfCount: 2, pdfBytesUsed: 1600 });
  });
});

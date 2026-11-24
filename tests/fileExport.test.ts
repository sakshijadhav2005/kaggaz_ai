import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  getUri: vi.fn(),
  share: vi.fn(),
  expectExternalActivity: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { writeFile: mocks.writeFile, getUri: mocks.getUri },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: mocks.share } }));
vi.mock('../src/core/appLock', () => ({ expectExternalActivity: mocks.expectExternalActivity }));

import { exportStoredFile } from '../src/core/fileExport';
import type { StoredFile } from '../src/models';

const file: StoredFile = {
  id: 'bill-id',
  name: 'July bill.pdf',
  type: 'pdf',
  path: 'vault/Bills/bill-id.kgz',
  folder: 'Bills',
  status: 'ready',
  source: 'rule',
  language: 'en',
  importedAt: 1,
  text: '',
};

describe('exportStoredFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUri.mockResolvedValue({ uri: 'file:///cache/export.pdf' });
    mocks.share.mockResolvedValue(undefined);
  });

  it('shares a decrypted file from app cache', async () => {
    const read = vi.fn(async () => new Blob(['pdf bytes'], { type: 'application/pdf' }));

    await exportStoredFile(file, read);

    expect(read).toHaveBeenCalledWith({ path: file.path, name: file.name });
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      path: expect.stringMatching(/^exports\/\d+-July bill\.pdf$/),
      data: btoa('pdf bytes'),
      directory: 'CACHE',
      recursive: true,
    }));
    expect(mocks.expectExternalActivity).toHaveBeenCalledOnce();
    expect(mocks.share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/export.pdf'] }));
  });

  it('surfaces share errors', async () => {
    mocks.share.mockRejectedValue(new Error('share failed'));

    await expect(exportStoredFile(file, async () => new Blob(['pdf bytes']))).rejects.toThrow('share failed');
  });
});

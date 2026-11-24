import type { FileType } from '../models';

export interface StorageEntry {
  type: FileType;
  bytes: number;
}

export interface StorageDetails {
  fileCount: number;
  bytesUsed: number;
  pdfCount: number;
  pdfBytesUsed: number;
}

export function summarizeStorage(entries: readonly StorageEntry[]): StorageDetails {
  return entries.reduce<StorageDetails>(
    (total, entry) => ({
      fileCount: total.fileCount + 1,
      bytesUsed: total.bytesUsed + entry.bytes,
      pdfCount: total.pdfCount + Number(entry.type === 'pdf'),
      pdfBytesUsed: total.pdfBytesUsed + (entry.type === 'pdf' ? entry.bytes : 0),
    }),
    { fileCount: 0, bytesUsed: 0, pdfCount: 0, pdfBytesUsed: 0 },
  );
}

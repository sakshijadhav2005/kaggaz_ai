import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

import { expectExternalActivity } from './appLock';
import { blobToBase64 } from './base64';
import type { StoredFile } from '../models';
import { strings } from '../i18n';

const safeName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'document';

/** Downloads in a browser; on mobile, opens the system share sheet so the user can save the decrypted file. */
export async function exportStoredFile(file: StoredFile, read: (f: { path: string; name: string }) => Promise<Blob>): Promise<void> {
  const blob = await read(file);
  const name = safeName(file.name);
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), { href: url, download: name });
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const path = `exports/${Date.now()}-${name}`;
  await Filesystem.writeFile({ path, data: await blobToBase64(blob), directory: Directory.Cache, recursive: true });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  expectExternalActivity();
  // Keep the cache copy available while the receiving app reads the shared URI.
  await Share.share({ title: file.name, files: [uri], dialogTitle: strings().chat.downloadTitle });
}

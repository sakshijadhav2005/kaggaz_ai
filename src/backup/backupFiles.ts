import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

import { expectExternalActivity } from '../core/appLock';
import { bytesToBase64 } from '../core/crypto';
import { strings } from '../i18n';

/*
 * Where backups go. Android: written piece by piece to the app's cache, then handed to the share sheet so
 * the user can save it to Drive, Files or a USB stick. Browser: downloaded. Restoring reads the picked file
 * in slices (blobSource), so neither direction holds the whole backup in memory on the phone.
 */

const DIR = 'backups';

export const backupFileName = (d = new Date()) => `Kaagaz backup ${d.toISOString().slice(0, 10)}.kgbackup`;

/** Runs [produce] with a writer, then offers the finished file to the user. */
export async function saveBackup<T>(produce: (write: (bytes: Uint8Array) => Promise<void>) => Promise<T>): Promise<T> {
  const name = backupFileName();
  if (!Capacitor.isNativePlatform()) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    const result = await produce(async (b) => void parts.push(b.slice()));
    const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return result;
  }

  // Only the latest backup is kept in the cache; older ones were already shared.
  try {
    await Filesystem.rmdir({ path: DIR, directory: Directory.Cache, recursive: true });
  } catch {
    // Nothing there yet.
  }
  const path = `${DIR}/${name}`;
  let first = true;
  const result = await produce(async (bytes) => {
    const data = bytesToBase64(bytes);
    if (first) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
    else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    first = false;
  });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  expectExternalActivity(); // the share sheet must not trigger the app lock
  try {
    await Share.share({ title: strings().backup.shareTitle, files: [uri], dialogTitle: strings().backup.shareTitle });
  } catch (e) {
    if (!/cancel/i.test(String(e))) throw e;
    throw new Error(strings().backup.shareClosed);
  }
  return result;
}

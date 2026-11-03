import { Directory, Filesystem } from '@capacitor/filesystem';

import type { VaultStore } from '../interfaces';
import { FOLDERS, mimeFor } from '../models';
import { base64ToBytes, bytesToBase64, isEncryptedBytes, type FieldCipher } from './crypto';

const ROOT = 'vault';

/**
 * App-private storage (Capacitor Filesystem, Directory.Data). Each folder is a subdirectory.
 * Files are AES-GCM encrypted on disk and named by id only, so the path reveals nothing about the document.
 */
export class CapacitorVault implements VaultStore {
  constructor(private cipher: FieldCipher) {}

  async init() {
    for (const f of FOLDERS) {
      try {
        await Filesystem.mkdir({ path: `${ROOT}/${f}`, directory: Directory.Data, recursive: true });
      } catch {
        // Already exists.
      }
    }
  }

  async store(data: Blob, _name: string, id: string, folder: string) {
    const path = `${ROOT}/${folder}/${id}.kgz`;
    await this.writeEncrypted(path, new Uint8Array(await data.arrayBuffer()));
    return path;
  }

  async move(path: string, folder: string) {
    const dest = `${ROOT}/${folder}/${path.split('/').pop()}`;
    if (dest === path) return path;
    await Filesystem.rename({ from: path, to: dest, directory: Directory.Data, toDirectory: Directory.Data });
    return dest;
  }

  async remove(path: string) {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  }

  async read(path: string, name: string) {
    const bytes = await this.cipher.decryptBytes(await this.readRaw(path));
    return new Blob([bytes], { type: mimeFor(name) });
  }

  /**
   * Encrypts a file stored before encryption and renames it to its id. Returns the new path, or the old
   * one if the file was already encrypted. The plain copy is deleted only after the encrypted one is written.
   */
  async encryptLegacy(path: string, id: string, folder: string): Promise<string> {
    const raw = await this.readRaw(path);
    if (isEncryptedBytes(raw)) return path;
    const dest = `${ROOT}/${folder}/${id}.kgz`;
    await this.writeEncrypted(dest, raw);
    if (dest !== path) await this.remove(path);
    return dest;
  }

  private async writeEncrypted(path: string, plain: Uint8Array<ArrayBuffer>) {
    const data = bytesToBase64(await this.cipher.encryptBytes(plain));
    await Filesystem.writeFile({ path, data, directory: Directory.Data, recursive: true });
  }

  private async readRaw(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Data });
    // Web returns a Blob, native returns base64.
    return data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : base64ToBytes(data);
  }
}

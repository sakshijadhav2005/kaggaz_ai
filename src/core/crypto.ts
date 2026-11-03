/**
 * AES-256-GCM encryption for everything Kaagaz stores: database fields and vault files.
 * One data key per install, kept in the Android Keystore (see keyStore.ts).
 *
 * Formats
 * - bytes:  "KGZ1" (4 bytes) | IV (12 bytes) | ciphertext + GCM tag
 * - string: "enc1:" + base64(IV | ciphertext + tag)
 *
 * Values without the marker are legacy plaintext and are returned unchanged, so data written before
 * encryption still reads; `migrateToEncrypted` (db.ts, vault.ts) rewrites it once.
 */

const MAGIC = new Uint8Array([0x4b, 0x47, 0x5a, 0x31]); // "KGZ1"
const STRING_PREFIX = 'enc1:';
const IV_BYTES = 12;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const isEncryptedBytes = (b: Uint8Array) => b.length >= MAGIC.length + IV_BYTES && MAGIC.every((m, i) => b[i] === m);
export const isEncryptedString = (s: unknown): s is string => typeof s === 'string' && s.startsWith(STRING_PREFIX);

export class FieldCipher {
  private constructor(private key: CryptoKey) {}

  /** 32 random bytes for a new data key. */
  static generateRawKey(): Uint8Array<ArrayBuffer> {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  /** The imported key is non-extractable: JS can use it but not read it back. */
  static async fromRawKey(raw: Uint8Array<ArrayBuffer>): Promise<FieldCipher> {
    if (raw.length !== 32) throw new Error('Encryption key must be 32 bytes.');
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return new FieldCipher(key);
  }

  private async seal(plain: Uint8Array<ArrayBuffer>): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: Uint8Array }> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plain));
    return { iv, ct };
  }

  private async open(iv: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.key, ct));
  }

  async encryptBytes(plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const { iv, ct } = await this.seal(plain);
    const out = new Uint8Array(MAGIC.length + IV_BYTES + ct.length);
    out.set(MAGIC, 0);
    out.set(iv, MAGIC.length);
    out.set(ct, MAGIC.length + IV_BYTES);
    return out;
  }

  /** Legacy plaintext (no marker) is returned unchanged. A wrong key or tampered data throws. */
  async decryptBytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (!isEncryptedBytes(data)) return data;
    const iv = data.slice(MAGIC.length, MAGIC.length + IV_BYTES);
    return this.open(iv, data.slice(MAGIC.length + IV_BYTES));
  }

  async encryptString(s: string): Promise<string> {
    const { iv, ct } = await this.seal(new TextEncoder().encode(s));
    const joined = new Uint8Array(IV_BYTES + ct.length);
    joined.set(iv, 0);
    joined.set(ct, IV_BYTES);
    return STRING_PREFIX + bytesToBase64(joined);
  }

  async decryptString(s: string): Promise<string> {
    if (!isEncryptedString(s)) return s;
    const joined = base64ToBytes(s.slice(STRING_PREFIX.length));
    return new TextDecoder().decode(await this.open(joined.slice(0, IV_BYTES), joined.slice(IV_BYTES)));
  }

  /** Any JSON value (numbers, arrays, objects) as one encrypted string. */
  encryptJson = (v: unknown) => this.encryptString(JSON.stringify(v));
  decryptJson = async <T>(s: string): Promise<T> => JSON.parse(await this.decryptString(s)) as T;
}

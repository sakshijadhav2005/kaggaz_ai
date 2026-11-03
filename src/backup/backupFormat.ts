/*
 * The .kgbackup file format. Password-based, so a backup can be restored on a new phone after the old one
 * (and its Keystore key) is gone.
 *
 *   header:  "KGBK" | version (1 byte) | salt (16) | PBKDF2 iterations (uint32 BE)
 *   records: length of what follows (uint32 BE) | IV (12) | AES-256-GCM ciphertext + tag
 *
 * Each record's plaintext is: meta length (uint32 BE) | meta JSON | payload bytes.
 * The record's sequence number is the GCM additional data, so records cannot be reordered, dropped or
 * repeated without failing authentication. The last record is {t:"end", count}; a file cut short has no
 * valid end record and is rejected. The header itself is authenticated as the additional data of record 0.
 *
 * Records are at most PART_BYTES of payload, so neither writing nor reading needs the whole backup in memory.
 */

export const MAGIC = new Uint8Array([0x4b, 0x47, 0x42, 0x4b]); // "KGBK"
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 4 + 1 + 16 + 4;
export const DEFAULT_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-SHA256
export const PART_BYTES = 4 * 1024 * 1024;
export const MIN_PASSWORD = 8;

/** Payloads bigger than PART_BYTES span several records with the same name or id. */
export type Meta =
  | { t: 'data'; name: string; part: number; last: boolean }
  | { t: 'file'; id: string; part: number; last: boolean }
  | { t: 'end'; count: number };

export interface Rec {
  meta: Meta;
  payload: Uint8Array;
}

import { strings } from '../i18n';

export class BackupError extends Error {}

const E = () => strings().backupErrors;

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const readU32 = (b: Uint8Array, at = 0) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Additional data for record [seq]: its number, plus the header for record 0. */
function aad(seq: number, header: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(seq));
  return seq === 0 ? concat([n, header]) : n;
}

/** Turns records into encrypted bytes. Call add() per record, then end(); each returns bytes to write. */
export class BackupWriter {
  private seq = 0;
  private constructor(
    private key: CryptoKey,
    readonly header: Uint8Array<ArrayBuffer>,
  ) {}

  static async create(password: string, iterations = DEFAULT_ITERATIONS): Promise<BackupWriter> {
    if (password.length < MIN_PASSWORD) throw new BackupError(E().shortPassword(MIN_PASSWORD));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const header = concat([MAGIC, new Uint8Array([FORMAT_VERSION]), salt, u32(iterations)]);
    return new BackupWriter(await deriveKey(password, salt, iterations), header);
  }

  async add(meta: Meta, payload: Uint8Array = new Uint8Array()): Promise<Uint8Array<ArrayBuffer>> {
    if (payload.length > PART_BYTES) throw new Error('Record payload too large; split it first.');
    const m = new TextEncoder().encode(JSON.stringify(meta));
    const plain = concat([u32(m.length), m, payload]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(this.seq, this.header) }, this.key, plain));
    this.seq++;
    return concat([u32(iv.length + ct.length), iv, ct]);
  }

  /** The closing record. Its count lets the reader detect a file cut short. */
  end(): Promise<Uint8Array<ArrayBuffer>> {
    return this.add({ t: 'end', count: this.seq });
  }

  /** A whole payload as one or more records. */
  async *parts(base: { t: 'data'; name: string } | { t: 'file'; id: string }, bytes: Uint8Array): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    const n = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
    for (let i = 0; i < n; i++) {
      yield await this.add({ ...base, part: i, last: i === n - 1 } as Meta, bytes.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
    }
  }
}

/** Random access to the backup's bytes: a File/Blob in the app, an array in tests. */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
}

export const blobSource = (b: Blob): ByteSource => ({
  size: b.size,
  read: async (offset, length) => new Uint8Array(await b.slice(offset, offset + length).arrayBuffer()),
});

/**
 * Yields each record in order, decrypted and checked. Throws BackupError for a wrong password, a file
 * that is not a backup, or one that was changed or cut short.
 */
export async function* readBackup(src: ByteSource, password: string): AsyncGenerator<Rec> {
  if (src.size < HEADER_BYTES) throw new BackupError(E().notBackup);
  const header = await src.read(0, HEADER_BYTES);
  if (!MAGIC.every((m, i) => header[i] === m)) throw new BackupError(E().notBackup);
  if (header[4] !== FORMAT_VERSION) throw new BackupError(E().newer);
  const iterations = readU32(header, 21);
  if (iterations < 100_000 || iterations > 10_000_000) throw new BackupError(E().damaged);
  const key = await deriveKey(password, header.slice(5, 21), iterations);

  let at = HEADER_BYTES;
  let seq = 0;
  for (;;) {
    if (at + 4 > src.size) throw new BackupError(E().incomplete);
    const len = readU32(await src.read(at, 4));
    if (len < 12 + 16 || len > PART_BYTES + 64 * 1024 || at + 4 + len > src.size) throw new BackupError(E().incompleteOrDamaged);
    const body = await src.read(at + 4, len);
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: body.slice(0, 12), additionalData: aad(seq, header) }, key, body.slice(12)));
    } catch {
      throw new BackupError(seq === 0 ? E().wrongPassword : E().changed);
    }
    const mLen = readU32(plain);
    const meta = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + mLen))) as Meta;
    at += 4 + len;
    if (meta.t === 'end') {
      if (meta.count !== seq) throw new BackupError(E().changed);
      return;
    }
    yield { meta, payload: plain.subarray(4 + mLen) };
    seq++;
  }
}

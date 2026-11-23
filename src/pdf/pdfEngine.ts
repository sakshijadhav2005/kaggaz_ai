import { isPdfErrorCode, PdfOpError, type PdfErrorCode } from './pdfErrors';
import type { OPS } from './pdfDispatch';

/*
 * Runs pdfOps in a Web Worker (pdfDispatch.ts on the worker side) so big PDFs do not freeze the screen. Requests carry an id; replies are
 * matched by it. Buffers are copied before they are transferred, so the caller's bytes stay usable
 * (a transferred ArrayBuffer is detached and reads as empty).
 */

export type OpName = keyof typeof OPS;
type Args<K extends OpName> = Parameters<(typeof OPS)[K]>;
type Result<K extends OpName> = Awaited<ReturnType<(typeof OPS)[K]>>;

export interface Request { id: number; op: OpName; args: unknown[] }
export type Reply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; userFacing: boolean; code?: PdfErrorCode; params?: unknown[] };

/** Every ArrayBuffer inside [v], for the transfer list. */
export function buffers(v: unknown, out: Set<ArrayBuffer> = new Set()): ArrayBuffer[] {
  if (v instanceof Uint8Array) {
    if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
  } else if (Array.isArray(v)) v.forEach((x) => buffers(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => buffers(x, out));
  return [...out];
}

/** Copies every Uint8Array so transferring cannot detach the caller's data. */
function cloneBytes<T>(v: T): T {
  if (v instanceof Uint8Array) return v.slice() as T;
  if (Array.isArray(v)) return v.map(cloneBytes) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneBytes(x)])) as T;
  return v;
}

/** What the engine needs from a Worker; tests pass an in-process fake. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<Reply>) => void): void;
  addEventListener(type: 'error', fn: (e: ErrorEvent) => void): void;
  terminate(): void;
}

/** Rebuilds the worker's error on this side: a coded PdfOpError when it has a known code, else a plain Error. */
function toError(r: Extract<Reply, { ok: false }>): Error {
  if (r.userFacing && isPdfErrorCode(r.code)) {
    // The params came from a PdfOpError with this code, so they fit its constructor.
    return new (PdfOpError as new (code: PdfErrorCode, ...p: unknown[]) => PdfOpError)(r.code, ...(r.params ?? []));
  }
  return new Error(r.error);
}

export class PdfEngine {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private makeWorker: () => WorkerLike) {}

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.makeWorker();
    w.addEventListener('message', (e: MessageEvent<Reply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(toError(e.data));
    });
    w.addEventListener('error', (e: ErrorEvent) => {
      // A crashed worker (e.g. out of memory) fails everything in flight; the next call starts a new one.
      const err = new PdfOpError('workerStopped', e.message || 'unknown error');
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    });
    this.worker = w;
    return w;
  }

  run<K extends OpName>(op: K, ...args: Args<K>): Promise<Result<K>> {
    const w = this.ensure();
    const id = this.nextId++;
    const copy = cloneBytes(args);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage({ id, op, args: copy } satisfies Request, buffers(copy));
    });
  }
}

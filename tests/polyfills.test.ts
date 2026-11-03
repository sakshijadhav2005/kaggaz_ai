import { describe, expect, it } from 'vitest';

import { polyfillReadableStreamIteration } from '../src/streamsPolyfill';

/** A stand-in for an old WebView's ReadableStream: it can be read, but cannot be iterated. */
function oldStream(chunks: unknown[]) {
  const log = { cancelled: false, released: false };
  class OldReadableStream {
    getReader() {
      let i = 0;
      return {
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: async () => void (log.cancelled = true),
        releaseLock: () => void (log.released = true),
      };
    }
  }
  return { Stream: OldReadableStream as never, log, make: () => new OldReadableStream() };
}

describe('ReadableStream async iteration for old WebViews', () => {
  it('lets for-await read every chunk', async () => {
    const { Stream, make, log } = oldStream([1, 2, 3]);
    polyfillReadableStreamIteration(Stream);
    const seen: unknown[] = [];
    for await (const chunk of make() as unknown as AsyncIterable<unknown>) seen.push(chunk);
    expect(seen).toEqual([1, 2, 3]);
    expect(log.cancelled).toBe(false); // read to the end
    expect(log.released).toBe(true);
  });

  it('cancels the stream when the loop is left early', async () => {
    const { Stream, make, log } = oldStream([1, 2, 3]);
    polyfillReadableStreamIteration(Stream);
    for await (const chunk of make() as unknown as AsyncIterable<unknown>) {
      if (chunk === 2) break;
    }
    expect(log.cancelled).toBe(true);
    expect(log.released).toBe(true);
  });

  it('leaves a browser that already supports it alone', () => {
    const own = async function* () {};
    class Modern {
      getReader() {
        return {} as never;
      }
    }
    (Modern.prototype as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = own;
    polyfillReadableStreamIteration(Modern as never);
    expect((Modern.prototype as unknown as Record<symbol, unknown>)[Symbol.asyncIterator]).toBe(own);
  });

  it('does nothing where there is no ReadableStream', () => {
    expect(() => polyfillReadableStreamIteration(undefined)).not.toThrow();
  });
});

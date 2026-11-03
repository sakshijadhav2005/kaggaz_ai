/** The part of a ReadableStream that async iteration needs. */
interface StreamLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(): Promise<unknown>;
    releaseLock(): void;
  };
}

type StreamClass = { prototype: StreamLike & Record<symbol, unknown> };

/**
 * `for await (const chunk of readableStream)` needs Chrome 124. Older Android WebViews have ReadableStream
 * without it, and pdf.js reads page text that way ("t is not async iterable"). Adds it where it is missing.
 */
export function polyfillReadableStreamIteration(StreamCtor: StreamClass | undefined = (globalThis as unknown as { ReadableStream?: StreamClass }).ReadableStream): void {
  if (!StreamCtor || Symbol.asyncIterator in StreamCtor.prototype) return;
  StreamCtor.prototype[Symbol.asyncIterator] = async function* (this: StreamLike) {
    const reader = this.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          return;
        }
        yield value;
      }
    } finally {
      // Leaving the loop early (break or error) cancels the stream, as the standard does.
      if (!finished) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
}

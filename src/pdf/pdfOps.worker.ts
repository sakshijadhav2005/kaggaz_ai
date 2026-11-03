// Web Worker entry for PDF page operations (see pdfEngine.ts). Needs the same polyfills as the page.
import '../polyfills';
import { handleRequest } from './pdfDispatch';
import type { Request } from './pdfEngine';

self.addEventListener('message', async (e: MessageEvent<Request>) => {
  const { reply, transfer } = await handleRequest(e.data);
  (self as unknown as Worker).postMessage(reply, transfer);
});

// The pdf.js worker runs in its own scope, so it needs the polyfills too.
import '../polyfills';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';

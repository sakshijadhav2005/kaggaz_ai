/**
 * Android phones run the app in the system WebView, which is often a year or more behind Chrome and lacks newer
 * JavaScript features (Promise.withResolvers, Object.groupBy, Array.fromAsync, ...) that pdf.js and others use.
 * Without these the app starts but PDFs silently yield no text. This must load before anything else, in the page
 * and in the pdf.js worker.
 */
import 'core-js/stable';

import { polyfillReadableStreamIteration } from './streamsPolyfill';

polyfillReadableStreamIteration();

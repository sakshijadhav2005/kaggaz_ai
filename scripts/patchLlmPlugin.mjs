// @capgo/capacitor-llm starts LiteRT-LM with the CPU backend for text, vision AND audio. Gemma 4 E2B has vision and
// audio encoders, so that loads (and keeps in memory) parts this app never uses: text in, text out. LiteRT-LM accepts
// null for both, which is its documented text-only setup. Runs after `npm install`, so it survives reinstalls.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FILE = 'node_modules/@capgo/capacitor-llm/android/src/main/java/ee/forgr/capgo_llm/LLM.java';

const BEFORE = `            actualPath,
            primaryBackend,
            primaryBackend,
            primaryBackend,
            request.maxTokens,`;
const AFTER = `            actualPath,
            primaryBackend,
            null, // vision backend: not used, so not loaded
            null, // audio backend: not used, so not loaded
            request.maxTokens,`;

/** Returns the patched source, the same source if already patched, or null if the code is not what we expect. */
export function patchSource(source) {
  if (source.includes(AFTER)) return source;
  return source.includes(BEFORE) ? source.replace(BEFORE, AFTER) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(FILE)) {
    console.log('patchLlmPlugin: plugin not installed, nothing to do');
  } else {
    const src = readFileSync(FILE, 'utf8');
    const out = patchSource(src);
    if (out === null) {
      console.error('patchLlmPlugin: the plugin source changed; check whether this patch is still needed');
      process.exit(1);
    }
    if (out !== src) writeFileSync(FILE, out);
    console.log(out === src ? 'patchLlmPlugin: already patched' : 'patchLlmPlugin: patched');
  }
}

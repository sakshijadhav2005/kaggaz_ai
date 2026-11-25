// @capgo/capacitor-llm starts LiteRT-LM with the CPU backend for text, vision AND audio. Gemma 4 E2B has vision and
// audio encoders, so that loads (and keeps in memory) parts this app never uses: text in, text out. LiteRT-LM accepts
// null for both, which is its documented text-only setup. Runs after `npm install`, so it survives reinstalls.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FILE = 'node_modules/@capgo/capacitor-llm/android/src/main/java/ee/forgr/capgo_llm/LLM.java';
export const DOWNLOADER_FILE = 'node_modules/@capgo/capacitor-llm/android/src/main/java/ee/forgr/capgo_llm/LLMPlugin.java';

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

const DOWNLOAD_BEFORE = `    private void downloadFile(String urlString, java.io.File outputFile, ProgressCallback callback) throws Exception {
        java.net.URL url = new java.net.URL(urlString);
        java.net.HttpURLConnection connection = (java.net.HttpURLConnection) url.openConnection();
        connection.connect();

        int fileLength = connection.getContentLength();
        java.io.InputStream input = new java.io.BufferedInputStream(connection.getInputStream());
        java.io.FileOutputStream output = new java.io.FileOutputStream(outputFile);

        byte[] data = new byte[4096];
        long total = 0;
        int count;

        while ((count = input.read(data)) != -1) {
            total += count;
            if (fileLength > 0 && callback != null) {
                callback.onProgress((int) ((total * 100) / fileLength));
            }
            output.write(data, 0, count);
        }

        output.flush();
        output.close();
        input.close();
    }`;
const DOWNLOAD_AFTER = `    private void downloadFile(String urlString, java.io.File outputFile, ProgressCallback callback) throws Exception {
        long existingBytes = outputFile.exists() ? outputFile.length() : 0L;
        java.net.HttpURLConnection connection = null;
        try {
            java.net.URL url = new java.net.URL(urlString);
            connection = (java.net.HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(60000);
            if (existingBytes > 0) {
                connection.setRequestProperty("Range", "bytes=" + existingBytes + "-");
            }
            connection.connect();

            int responseCode = connection.getResponseCode();
            if (existingBytes > 0 && responseCode == 416) {
                connection.disconnect();
                existingBytes = 0L;
                connection = (java.net.HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(30000);
                connection.setReadTimeout(60000);
                connection.connect();
                responseCode = connection.getResponseCode();
            }

            boolean append = existingBytes > 0 && responseCode == java.net.HttpURLConnection.HTTP_PARTIAL;
            if (!append && responseCode != java.net.HttpURLConnection.HTTP_OK) {
                throw new java.io.IOException("Model download failed with HTTP " + responseCode);
            }
            if (!append) {
                existingBytes = 0L;
            }

            long responseLength = -1L;
            String lengthHeader = connection.getHeaderField("Content-Length");
            if (lengthHeader != null) {
                try {
                    responseLength = Long.parseLong(lengthHeader);
                } catch (NumberFormatException ignored) {
                    responseLength = -1L;
                }
            }
            long totalLength = responseLength > 0 ? existingBytes + responseLength : -1L;
            long total = existingBytes;
            byte[] data = new byte[1024 * 1024];
            try (
                java.io.InputStream input = new java.io.BufferedInputStream(connection.getInputStream(), data.length);
                java.io.FileOutputStream output = new java.io.FileOutputStream(outputFile, append)
            ) {
                int count;
                while ((count = input.read(data)) != -1) {
                    output.write(data, 0, count);
                    total += count;
                    if (totalLength > 0 && callback != null) {
                        callback.onProgress((int) Math.min(99L, (total * 100L) / totalLength));
                    }
                }
            }
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }`;
const PREVIOUS_DOWNLOAD_AFTER = DOWNLOAD_AFTER.replace('responseCode == 416', 'responseCode == java.net.HttpURLConnection.HTTP_REQUESTED_RANGE_NOT_SATISFIABLE');

/** Returns the patched source, the same source if already patched, or null if the code is not what we expect. */
export function patchSource(source) {
  if (source.includes(AFTER)) return source;
  return source.includes(BEFORE) ? source.replace(BEFORE, AFTER) : null;
}

/** Returns the faster resumable downloader, the same source if already patched, or null if it changed. */
export function patchDownloaderSource(source) {
  if (source.includes(DOWNLOAD_AFTER)) return source;
  if (source.includes(PREVIOUS_DOWNLOAD_AFTER)) return source.replace(PREVIOUS_DOWNLOAD_AFTER, DOWNLOAD_AFTER);
  return source.includes(DOWNLOAD_BEFORE) ? source.replace(DOWNLOAD_BEFORE, DOWNLOAD_AFTER) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(FILE) || !existsSync(DOWNLOADER_FILE)) {
    console.log('patchLlmPlugin: plugin not installed, nothing to do');
  } else {
    const patches = [
      [FILE, patchSource],
      [DOWNLOADER_FILE, patchDownloaderSource],
    ].map(([file, patch]) => {
      const source = readFileSync(file, 'utf8');
      return { file, source, output: patch(source) };
    });
    const failed = patches.find(({ output }) => output === null);
    if (failed) {
      console.error(`patchLlmPlugin: ${failed.file} changed; check whether this patch is still needed`);
      process.exit(1);
    }
    for (const { file, source, output } of patches) {
      if (output !== source) writeFileSync(file, output);
      console.log(output === source ? `patchLlmPlugin: already patched ${file}` : `patchLlmPlugin: patched ${file}`);
    }
  }
}

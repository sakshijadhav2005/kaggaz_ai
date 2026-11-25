# Kaagaz

Mobile app that stores documents, sorts them into folders automatically, and finds them by name or question, with citations. Built to `KAAGAZ_MVP_SPEC.md` with React + TypeScript (Vite) inside a Capacitor shell.

## Run

```
npm install
npm run dev          # open in a browser (works for everything except push notifications)
npm test             # unit tests + end-to-end ingest test on a fake IndexedDB
npm run build        # typecheck + production build
```

Android (needs Android Studio):

```
npm run sync         # build the web app and copy it into android/
npx cap open android # then Run from Android Studio
```

Online calls go through the **Kaagaz proxy** (`proxy/`, a Cloudflare Worker), which holds the Gemini API key, so the app never contains it. Deploy it (see `proxy/README.md`), then set `VITE_PROXY_URL` in `.env.local` before building. Each install gets an anonymous token by itself; there is nothing to enter.

For development without the proxy, leave `VITE_PROXY_URL` unset and paste a Gemini API key in Settings, or set `VITE_GEMINI_API_KEY` in `.env.local`. Never ship such a build: the key would be readable from the APK. `VITE_LLM_MODEL`, `VITE_EMBED_MODEL` and `VITE_TRANSCRIBE_MODEL` apply to development mode only; with the proxy, the models are set in `proxy/wrangler.toml`.

Without a key the app still imports, OCRs, sorts by rules and searches by folder or keyword. Answers, Gemma sorting and embeddings need the key and a connection.

## Layout

| Spec part | Code |
|---|---|
| Interfaces, data shapes | `src/interfaces.ts`, `src/models.ts` |
| Vault, DB | `src/core/vault.ts` (Capacitor Filesystem), `src/core/db.ts` (IndexedDB via Dexie) |
| Extract | `src/extract/` (pdf.js text layer, Tesseract OCR English + Hindi, Gemma image fallback, audio transcription) |
| Smart sort | `src/sort/`, rules in `src/sort/rules.json` |
| Folder/keyword search | `src/search/folderSearch.ts` |
| Index and answers | `src/index/`, `src/answer/answerer.ts` |
| Bills, reminders | `src/records/recordParser.ts`, `src/core/ingestService.ts`, `src/core/scheduler.ts` |
| Gemma and embeddings | `src/llm/gemini.ts` (the only file that talks to a server), `proxy/` (holds the key) |
| Wiring | `src/services.ts` |
| UI | `src/ui/` |

## Notes

- **Appearance:** Settings uses a compact Theme dropdown for Warm light, Warm dark or Neon Glass. The selection is saved on the device; the header sun/moon button remains available for switching between light and dark.
- **Sorting:** import extracts text, applies offline rules for ID cards, bills, receipts and medical documents, then uses Gemma 4 when no rule matches and a model is available. Without a confident result the file stays Unsorted; poor text extraction is marked for review. A manual folder choice is kept.
- **Ask:** answers are instructed to stay brief and answer the requested fact. Mobile-number questions use the stored text directly and cite the source; document requests show matching file cards with a Download action.
- **Importing:** the Library has two buttons. Import picks files (PDF, images, audio). Scan, in the Android app, opens Google's ML Kit document scanner (camera, edge detection, crop, multi-page) and imports the result as one PDF. In a browser, Scan opens the camera or file picker instead.
- **OCR:** on a phone it uses ML Kit text recognition (Latin and Devanagari, works offline). In a browser, and as a backup if ML Kit fails, it uses Tesseract.js, whose language data downloads the first time it runs. If both read poorly and you are online, Gemma transcribes the image.
- ML Kit adds several MB to the Android app, one model per script.
- HEIC photos may not decode in every WebView. JPEG and PNG are safe.
- **Audio:** imported recordings (MP3, M4A, WAV, AAC, OGG) are turned into text, then sorted, searched and answered from like any document (`src/extract/audioExtractor.ts`).
  - Online only, with consent: the on-device Gemma 4 takes no audio. Offline, or for a locked file, nothing is sent and the file is sorted by its name; Retry in the viewer transcribes it later.
  - The hosted Gemma 4 31B takes no audio either, so transcription uses its own model: `TRANSCRIBE_MODEL` on the proxy (`gemini-2.5-flash` by default), or `VITE_TRANSCRIBE_MODEL` in development.
  - Recordings over 8 MB (about 8 minutes of 128 kbps MP3) are not sent and are sorted by name.
  - The whole recording is one passage, so answers cite the file, not a time in it.
- **Older WebViews:** the Android app runs in the system WebView, which on some phones is a year or more behind Chrome. `src/polyfills.ts` adds the JavaScript features pdf.js needs (`Promise.withResolvers`, `Object.groupBy`, stream iteration, ...) and loads both in the page and in the pdf.js worker. Without it the app starts but PDFs yield no text. Tested on Android 13 with WebView 103.
- `legacy-flutter/` holds the earlier Dart version. It was never compiled and can be deleted.

## Offline Gemma 4

Online, the app uses the hosted Gemma 4 (31B). With no connection or key, or if a hosted call fails, it uses **Gemma 4 E2B running on the phone** (LiteRT-LM, through `@capgo/capacitor-llm`). It is used for sorting unmatched files, written answers, general answers and file-name suggestions.

- Android app, Settings, **Download Gemma 4 E2B**. The model is about 2.6 GB, so it downloads on request (use Wi-Fi) instead of shipping inside the app.
- The model downloads through Android's DownloadManager (`android/app/src/main/java/app/kaagaz/ModelDownloadPlugin.java`), so it keeps going with the app in the background or the screen off, shows a notification, and retries when the network drops. The download's id is saved, so reopening the app picks it up again. The file is stored in the app's external files folder, which needs no permission and is removed on uninstall.
- Offline answers work from the best matching passages (plain word matching), because the embedding model is online-only. Answers cite the file and page. The on-device model has a small context window, so it is given at most 3 passages.
- It cannot read images or audio; the OCR fallback that sends a picture to Gemma, and audio transcription, stay online-only. ML Kit and Tesseract still read images offline.
- In a browser there is no on-device model; Settings says so.

## Security

- **Encryption at rest:** everything stored is encrypted with AES-256-GCM (`src/core/crypto.ts`). The 256-bit key is created on first launch and kept in Android secure storage, protected by the Keystore (`src/core/keyStore.ts`). It is never in the code or the logs.
  - Database: file names, document text, search chunks, embeddings, bills and reminder titles. Folder, dates and flags stay plain so queries work.
  - Vault files: encrypted on disk and named by id only (`vault/<folder>/<id>.kgz`).
  - The mobile Settings tab shows uploaded-file and PDF storage use. Vault files live in the app-private Capacitor `Directory.Data`, not the public Downloads folder; the displayed totals include Trash until files are permanently deleted.
  - Installs from before encryption are migrated once on launch (`src/core/encryptionMigration.ts`).
  - In a browser the key falls back to localStorage, which is not secure. Use the browser for development only.
  - Android backup is off (`allowBackup="false"`): the Keystore key cannot be backed up, so a restored copy could not be decrypted anyway.
- **Backup and restore:** Settings, Backup. All documents (including Trash), their text, search passages, bills and reminders go into one `.kgbackup` file, saved through the share sheet (Drive, Files, USB).
  - **Encryption:** the file is locked with a password the user chooses (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM). The phone's Keystore key is not used, so the backup still opens after the phone is lost. A forgotten password cannot be recovered.
  - **Tamper protection:** the file is written in pieces of at most 4 MB, so large vaults never sit in memory. Each piece is authenticated with its position, so reordering, removing or changing any piece is caught. A file cut short is rejected, and the error says how many documents were already restored.
  - **Restore only adds** documents not already on the phone, and never deletes or overwrites.
  - **Left out:** embeddings (rebuilt when online AI is on), settings, the lock, consent answers and the audit log.
  - Code: `src/backup/`.
- **App lock:** Settings, App lock. Fingerprint or face, with the phone's PIN or pattern as a fallback. It locks again after a set time in the background (immediately, 30 s, 1 min or 5 min). Opening the scanner or file picker does not lock it. Android app only.
- **Consent for online AI (DPDP Act):** nothing goes to the cloud until the user agrees to the notice (`src/core/consent.ts`). They are asked once after unlock, and can turn it on or off in Settings, Online AI.
  - The check is in `src/llm/gemini.ts`, where every request leaves the phone, so no feature can skip it.
  - Without consent everything runs on the phone: rule sorting, word search, offline Gemma 4.
  - Changing the notice means bumping `CLOUD_NOTICE_VERSION`, and everyone is asked again. Version 2 added audio recordings to what is sent.
  - Each answer is written to a hash-chained audit log (`Db.appendAudit`). Settings shows it with an integrity check.
- **Play Integrity (optional):** with it on, only the genuine app from Google Play on a real device can get a proxy token (`IntegrityPlugin.java`, `proxy/src/integrity.ts`). Setup: `proxy/README.md`.
- **No API key in the app:** release builds call the Kaagaz proxy with a per-install token kept in secure storage. The proxy fixes the model, caps request sizes and rate-limits each device.

## Hindi and English

- **Languages:** every screen, message and the consent notice is in English and Hindi (`src/i18n/en.ts`, `src/i18n/hi.ts`). It is chosen in Settings, Language; the first launch follows the phone's language.
- **Checks:**
  - `hi.ts` must have exactly the keys of `en.ts`, or the build fails.
  - A test fails if a Hindi string is missing or still English.
- **Answers:** online and offline Gemma reply in the language of the question.
- **PDF tool errors:** the worker cannot see the app's language, so each error crosses as a code and its parameters (`src/pdf/pdfErrors.ts`) and the screen shows it in Hindi or English. The assistant's model sees the English text and replies in the user's language.

## Voice

- **Speaking:** the microphone in the Ask tab fills the question box in Hindi or English, following the app language. Nothing is sent until you tap Send, so a misheard word never becomes a command.
- **Where it runs:** on Android it uses the phone's speech recogniser (`@capacitor-community/speech-recognition`). It works offline only if the phone has the Hindi or English offline speech pack; otherwise it is Google's online speech service, which is a phone setting, not Kaagaz's. In a browser it uses the Web Speech API where available.

## Locked documents

- **Locking:** Lock in the viewer. Opening a locked document then needs the fingerprint or screen lock every time, and removing the lock needs it too. The Library shows a lock badge and no page preview.
- **Never leaves the phone:** a locked document's text is left out of answers, embeddings and passage search, and keyword search matches its name only. Retry and "Suggest with Gemma 4" are hidden for it, because both can use online AI.
- **Off limits to the assistant:**
  - It is not in search or lists (only a count).
  - It cannot be used by id.
  - Its bills and reminders are left out of summaries.
  - The PDF tools refuse it.

## Commands in the Ask tab

Besides questions, the Ask tab carries out commands: "move my PAN card to Study", "rename the electricity bill to BSES August", "star my Aadhaar", "delete the old receipt", "open my marksheet", "what is due this week?", "how much did I spend in August?". Hindi works too ("आधार कार्ड हटाओ", "मेरा खर्च कितना है").

- **Routing** (`src/agent/skills.ts`): trigger words in English and Hindi decide, with no model call, whether a message is a command and which actions Gemma may use. "Give me Aadhaar card" still lists the folder instantly, and other questions still go to the answer pipeline.
- **Actions** (`src/agent/actions.ts`): each action is declared once with `defineAction` and a zod schema. The schema validates what the model sends and produces the action list in its prompt (`src/agent/registry.ts`).
- **Loop** (`src/agent/agent.ts`): Gemma replies with one JSON object per turn, either an action or a reply. The app runs the action and shows Gemma the result, for up to 5 rounds. It works the same with hosted and on-device Gemma 4.
- **Safety:**
  - Actions return names, folders, dates and ids, never document text.
  - Documents in Trash cannot be acted on.
  - Moving a file to Trash waits for the user's Confirm.
  - Delete forever and Empty trash are not actions, so the assistant cannot do them.
- Ask results and answer citations have a Download action. Browsers download the decrypted file directly; Android opens the share sheet so the user can save a copy elsewhere.
- **Adding an action:** add a `defineAction` to `buildRegistry`, list its id in a skill, and add a test in `tests/agent.test.ts`. The test "every skill names only registered actions" catches typos.

## PDF tools

The **Tools** tab, and the Ask tab ("merge my Aadhaar and PAN", "compress the electricity bill", "add page numbers to my resume", "आधार और पैन मर्ज करो"):

| Tool | Notes |
|---|---|
| Merge PDFs | In the order you tap them |
| Images to PDF | One page per image, fitted to A4. JPEG and PNG as they are; WebP converted |
| Compress | Renders pages to JPEG and rebuilds the PDF. Lossy, and the text is read again by OCR. Refused if the result would not be smaller |
| Extract pages, Split, Remove pages, Rotate | Pages like `1-3, 5`; `8-` means to the end |
| Watermark | Any language. Latin text is drawn as PDF text. Hindi and other scripts are drawn by the WebView as an image, because pdf-lib cannot shape Devanagari |
| Page numbers | "1 / 5" at the bottom |

- Every tool saves a **new** document through the normal import, so it is encrypted, read, indexed and searchable. The original never changes, which is why the assistant may run these tools without asking.
- If every input came from one folder, the result goes to that folder.
- Code:
  - `src/pdf/pdfOps.ts`: pdf-lib (MIT), no DOM.
  - `src/pdf/pdfEngine.ts` and `pdfOps.worker.ts`: run the operations in a Web Worker, copying buffers before transfer so the caller's bytes stay usable.
  - `src/pdf/pdfTools.ts`: by document id, on the vault.
  - `src/pdf/browserImages.ts`: the canvas steps.
- Inputs over 80 MB together are refused, to protect phone memory. Password-protected PDFs are refused with a clear message.

## Adding, renaming, favourites and trash

- **Add:** picking or scanning files opens a step where each file can be renamed (the extension is locked). A checkbox names the files you did not rename from their content with Gemma 4, online or on the device; with no model it uses the document's first title line.
- **Rename later:** the pencil on a row, or Rename in the viewer, with a "Suggest with Gemma 4" button.
- **Favourites:** the star on a row or in the viewer. Favourites is a section next to the folders.
- **Trash:** the bin moves a file to Trash. Trashed files disappear from folders, search, answers, expenses and reminders, and their reminder alert is cancelled. Restore brings everything back. Delete forever and Empty trash ask first and remove the file, its text and its search data.

## Eval (build step 8)

- **Sorting:** `npm test` prints the accuracy on the labeled sample in `tests/logic.test.ts`. Extend that list with real documents.
- **Answers:** edit `src/eval/eval_qa.json` (20-30 questions, each with the expected text and the file that should be cited), import your documents, then tap the check icon in the Library header. It needs the API key and a connection. A case passes only if the answer has the expected text and cites the right file; unanswerable questions pass only if the app says it couldn't find it.

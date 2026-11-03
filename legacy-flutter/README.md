# Kaagaz

Mobile app that stores documents, sorts them into folders automatically, and finds them by name or question, with citations. Built to `KAAGAZ_MVP_SPEC.md`.

## Setup

The repo has no `android/` or `ios/` folders yet. Generate them once:

```
flutter create . --project-name kaagaz --platforms=android,ios
flutter pub get
flutter test
flutter run --dart-define=GEMINI_API_KEY=<your key>
```

`LLM_MODEL` (default `gemma-3-27b-it`) and `EMBED_MODEL` (default `gemini-embedding-001`) can also be set with `--dart-define`.

Android: set `minSdkVersion 21` or higher (ML Kit). Without an API key the app still imports, OCRs, rule-sorts and does folder/keyword search; Gemma sorting, answers and embeddings need the key and a connection.

## Layout

| Spec part | Code |
|---|---|
| Interfaces | `lib/interfaces.dart`, `lib/models.dart` |
| Vault, DB | `lib/core/vault.dart`, `lib/core/db.dart` |
| Extract | `lib/extract/` (PDF text, device OCR, Gemma image fallback) |
| Smart sort | `lib/sort/`, rules in `assets/rules.json` |
| Folder/keyword search | `lib/search/folder_search.dart` |
| Index and answers | `lib/index/`, `lib/answer/answerer.dart` |
| Bills, reminders | `lib/records/record_parser.dart`, `lib/core/ingest_service.dart` |
| Gemma and embeddings | `lib/llm/gemini_api.dart` (the only file that talks to the API) |
| Wiring | `lib/services.dart` |

## Reminder notifications

Due-date reminders schedule a local notification at 09:00 on the due date. After `flutter create`, add to `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>
```

and, inside `<application>`, the plugin's `ScheduledNotificationReceiver` and `ScheduledNotificationBootReceiver` entries (see the flutter_local_notifications README). Without them the reminder list still works; only the alert is missing.

## Eval (build step 8)

- **Sorting:** `flutter test` prints the accuracy on the labeled sample in `test/core_logic_test.dart`. Extend that list with real documents.
- **Answers:** edit `assets/eval_qa.json` (20-30 questions, each with expected text and the file that should be cited), import your documents, then tap the checklist icon in the Library app bar. It needs the API key and a connection. A case passes only if the answer has the expected text and cites the right file; unanswerable questions pass only if the app says it couldn't find it.

# Kaagaz proxy

A Cloudflare Worker that holds the Gemini API key, so the app never contains it. The app calls three endpoints:

| Endpoint | Body | Returns | Limit |
|---|---|---|---|
| `POST /v1/register` | none | `{ token }` | 5 per minute per IP |
| `POST /v1/generate` | `{ parts }`: text, plus at most one image | `{ text }` | 20 per minute per device |
| `POST /v1/embed` | `{ text }` | `{ values }` | 120 per minute per device |

Each install registers once and keeps an anonymous token in Android secure storage. Tokens are signed with `TOKEN_SECRET`, so the Worker needs no database. The Worker chooses the model and drops anything else the client sends, so a token can only make these three calls.

## Deploy

You need a free Cloudflare account and a Gemini API key.

```
cd proxy
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY     # paste the key
npx wrangler secret put TOKEN_SECRET       # paste a long random string, e.g. from: node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
npm run deploy
```

`npm run deploy` prints the Worker's URL (`https://kaagaz-proxy.<you>.workers.dev`). Then build the app against it:

```
# in the app folder, .env.local
VITE_PROXY_URL=https://kaagaz-proxy.<you>.workers.dev
```

```
npm run sync
```

With `VITE_PROXY_URL` set, the app hides the API key field in Settings and never calls Google directly. Remove `VITE_GEMINI_API_KEY` from `.env.local` for release builds.

## Also do this in Google Cloud

The rate limits slow down abuse but do not cap cost, because anyone can register a token. In the Google Cloud console, for the project that owns the key:

- Set a daily quota on the Generative Language API (APIs and services, Quotas).
- Set a budget alert (Billing, Budgets).
- Restrict the key to the Generative Language API only.

## Play Integrity (only the genuine app may register)

Off by default: any install gets a token. Turn it on before a public launch, so a copied or modified APK, an emulator or a script cannot register.

With it on, registering works like this:

1. The app asks for a five-minute signed challenge (`/v1/challenge`).
2. Google Play on the phone turns the challenge into an integrity token.
3. The proxy has Google decode the token. It issues a device token only if all of these hold: the package is `app.kaagaz`, the challenge matches, the token is recent, the verdict is `PLAY_RECOGNIZED` (the app exactly as published on Play), and the device has `MEETS_DEVICE_INTEGRITY`.

Setup:

1. **Play Console:** App integrity, Play Integrity API. Link a Google Cloud project, and note its **project number**.
2. **Google Cloud,** in that project:
   1. Enable the Play Integrity API.
   2. Create a service account.
   3. Create a JSON key for it.
3. **Proxy:**
   ```
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT   # paste the whole JSON key
   ```
   In `wrangler.toml`, set `PLAY_INTEGRITY = "required"`, then run `npm run deploy`.
4. **App:** in `.env.local`, set `VITE_PLAY_CLOUD_PROJECT_NUMBER=<project number>`, then run `npm run sync` and build the release.

Order matters:

- **Ship the app build with the project number first, and turn the proxy on after.** Older installs without integrity cannot register once it is on. Installs that already have a token keep working.
- **Sideloaded and debug builds** fail the `PLAY_RECOGNIZED` check. Test through a Play internal testing track.

## Gemini billing tier and the privacy notice

Google treats data sent through the Gemini API differently on the free and paid tiers. On the free tier it may be used to improve Google's products and seen by human reviewers. Check Google's current Gemini API terms.

For users' personal documents, use a key from a project with billing enabled (paid tier). Make sure the in-app notice (`CLOUD_NOTICE` in `src/core/consent.ts`) and the privacy policy describe the tier you actually use. If you change what the notice says, bump `CLOUD_NOTICE_VERSION` so users are asked again.

## Operations

- **Revoke every token:** run `npx wrangler secret put TOKEN_SECRET` with a new value. Apps re-register on their next call without the user noticing.
- **Change the model:** edit `LLM_MODEL` or `EMBED_MODEL` in `wrangler.toml` and redeploy. No app update is needed.
- **Logs:** run `npx wrangler tail`. Upstream errors are logged here and never sent to the app.
- **Local run:** copy `.dev.vars.example` to `.dev.vars`, run `npm run dev`, and set `VITE_PROXY_URL=http://localhost:8787` in the app.

The code is in `src/index.ts`. Its tests are in the app's `tests/proxy.test.ts` (`npm test` from the app folder).

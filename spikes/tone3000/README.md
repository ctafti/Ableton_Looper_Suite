# TONE3000 OAuth (PKCE) + Fetch-One-A2-Model Spike (Deliverable D)

Proves the TONE3000 path the `load_tone` tool (Contract 4) depends on:
authenticate with OAuth 2.0 + PKCE, find an **A2** tone, list its A2 models,
download one model file. All **off-rig** — no Mac/Ableton needed.

## What's here

| File | Job | Runs off-rig without creds? |
| --- | --- | --- |
| `src/pkce.ts` | PKCE verifier/challenge (S256, base64url) | ✅ pure crypto, has a self-test |
| `src/oauth.ts` | build authorize URL + token exchange + refresh | ✅ URL build is pure; token calls need a real code |
| `src/client.ts` | `T3KClient`: getTone / listModels / getModel / downloadModel | needs a real Bearer token |
| `src/headless-lan-flow.ts` | QR/LAN loopback-listener login (arch §2/§9) | ✅ STUB-prints without `T3K_CLIENT_ID` |
| `src/fetch-a2-model.ts` | end-to-end: token → A2 tone → model → save file | ✅ STUB-prints without creds |

**Everything is safe to run with zero credentials** — the interactive/network
pieces detect missing creds and print exactly what they *would* do, then exit 0.

## Run it

**Zero-install (Node 22+)** — every entry point runs with plain Node via
type-stripping, no `npm install`:

```bash
cd spikes/tone3000
node --experimental-strip-types src/pkce.ts              # PKCE self-test
node --experimental-strip-types src/headless-lan-flow.ts # STUB authorize URL
node --experimental-strip-types src/fetch-a2-model.ts    # STUB end-to-end plan
```

**Or via npm scripts (uses `tsx`):**

```bash
cd spikes/tone3000
npm install            # tsx + typescript
npm run pkce           # self-test the PKCE math (no creds needed)
npm run authorize-url  # STUB: prints the authorize URL it would open
npm run fetch-a2       # STUB: prints the end-to-end plan
npm run typecheck      # tsc --noEmit
```

## To run for real

1. Create a TONE3000 account and get your **publishable key** (starts `pk_…`).
   That is your `client_id`. (The **secret** key `t3k_cs_…` is server-only and is
   **not** used by PKCE — don't put it in `.env`.)
2. `cp .env.example .env` and set `T3K_CLIENT_ID=pk_…`.
3. Log in + fetch:
   ```bash
   # option A — full login, then fetch (needs a tone id):
   T3K_TONE_ID=<an A2 tone id> npm run fetch-a2
   # a QR/URL prints; approve on your phone; it captures the code and continues.

   # option B — if you already have a token:
   T3K_ACCESS_TOKEN=<token> T3K_TONE_ID=<id> npm run fetch-a2
   ```
   Success writes `./out/<modelId>.model` and prints
   "A2 fetch path proven end-to-end."

## App-registration requirements (from the TONE3000 API docs, verified 2026-07-01)

- **OAuth 2.0 + PKCE**, `code_challenge_method=S256`, base64url. Public client —
  **no client secret** in the flow.
- **Redirect URIs:**
  - **Dev:** `localhost` / loopback redirect URIs are **auto-allowed** — no
    registration needed. The headless flow uses `http://<LAN-IP>:<port>/callback`.
  - **Production:** **register your redirect URIs** in your TONE3000 account
    settings before shipping. LAN-IP redirect URIs used for the QR flow must be
    registered for production use.
- **Base URL:** `https://www.tone3000.com/api/v1`.
- **Token endpoint:** `POST /oauth/token`, `application/x-www-form-urlencoded`,
  returns `{access_token, refresh_token, token_type:'bearer', expires_in, scope}`.
- **A2 selector:** pass `architecture=2` to tone/model endpoints. **Omitting it
  returns legacy A1 + Custom and EXCLUDES A2** — so the NAM A2 flow must always
  send `architecture=2`.
- **Model download:** `model.model_url` is a pre-built URL; fetch it **with the
  Bearer token**.
- **Rate limit:** 100 requests/minute.

## How this grounds the contract

`load_tone` in Contract 4 is FREEZE-NOW as a **tool** because this spike proves
the fetch path. The only piece left is **rig-side**: handing the downloaded A2
model file to the amp device (NAM rack / Gateway) — that's a Phase-later task,
not a contract question.

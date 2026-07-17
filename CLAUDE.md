# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**GCK Automation** (`pubmatic-validator-dashboard`) — internal dashboard for PubMatic's Publisher Development and Customer Success teams. React SPA + a local Express proxy/backend, packaged as a macOS desktop app with Tauri.

Five tools, grouped in the sidebar (`constants.tsx` → `NAV_STRUCTURE`):

| Section | Tool | Route | Page |
|---|---|---|---|
| PUB DEV | Pub Onboarding Validator | `/` | `pages/PubOnboardingValidator.tsx` |
| CUSTOMER SUCCESS | Domain Level Revenue Intelligence | `/domain-revenue-intelligence` | `pages/DomainRevenueIntelligence.tsx` |
| CUSTOMER SUCCESS | Seller Domain Shooter | `/seller-domain-shooter` | `pages/Troubleshooter.tsx` |
| CUSTOMER SUCCESS | Auction Package Analyzer | `/ap-shooter` | `pages/APShooter.tsx` |
| CUSTOMER SUCCESS | Discrepancy Check-in | `/discrepancy-checkin` | `pages/DiscrepancyCheckin.tsx` |
| API TOKEN | Token Management | `/token-management` | `pages/TokenManager.tsx` |

## Commands

```bash
npm run dev          # Vite dev server on http://localhost:3000
npm run proxy        # Express proxy/backend on http://localhost:3001 (REQUIRED for most tools)
npm run build        # Production frontend build → dist/
npm run tauri:build  # Full macOS app build (~2-3 min); see COMMANDS.md
npx tsc --noEmit     # Type check (no test suite exists)
cd server && npm install   # Server deps (express, cors, node-fetch, nodemailer)
```

There is no test framework. Verify changes with `npx tsc --noEmit`, `node --check server/index.js`, and manual testing.

## Architecture

### Frontend (Vite + React 19 + TS 5.8, HashRouter)

- `App.tsx` — routes; `constants.tsx` — sidebar nav. Adding a tool requires: page in `pages/`, logic in `services/<tool>/`, nav item in `constants.tsx`, route in `App.tsx`.
- `services/` — one folder (or file) per tool. Pages hold UI state only; fetching/processing lives in services.
- Path alias `@/*` → repo root (both `tsconfig.json` and `vite.config.ts`).
- Styling: Tailwind v4 + hand-rolled classes in `index.css` scoped under `.ap-shooter-scope` (`glass-card`, `btn btn-primary/secondary`, `form-group`, `input-text`, `page-header`, `grid-2`...). New pages should wrap content in `<div className="ap-shooter-scope">` and reuse these classes.
- UI copy is English.

### Local server (`server/index.js`, ESM, port 3001)

Started with `npm run proxy`. Three responsibilities:

1. **CORS proxy** — `GET/POST /proxy?url=...`. URL must match `ALLOWED_PATTERNS` whitelist (sellers.json, app-ads.txt, app stores, `api.pubmatic.com`, `apps.pubmatic.com/api/admin-custom-report/`). Forwards `Authorization`, `Pubtoken`, and maps `x-pm-cookie` → `Cookie` (browsers cannot set `Cookie` directly).
2. **Email** — `POST /api/send-email` via nodemailer (Office365 STARTTLS). Supports CSV attachment.
3. **Slack** — `POST /api/slack` via `chat.postMessage`.

Secrets (EMAIL_USER/EMAIL_PASSWORD/SLACK_BOT_TOKEN, etc.) live in `server/.env` (gitignored; template: `server/.env.example`). They are loaded by a small built-in parser and must NEVER be sent to or hard-coded in the frontend.

### Tauri desktop app (`src-tauri/`)

- `npm run tauri:build` builds "GCK Automation.app" (`com.gck.automation`). `scripts/build-app.cjs` for per-arch builds; `npm run tauri:build:intel` / `:arm64` for cross-arch.
- Rust side exposes four commands (`src-tauri/src/lib.rs`): `native_fetch` (CORS-free HTTP via reqwest, honors macOS system proxy), `send_email` (SMTP STARTTLS via lettre, optional CSV attachment), `send_slack` (chat.postMessage), `get_send_config` (embedded-credential status, never returns secrets).
- **The packaged app needs NO local proxy.** Every Discrepancy/Token feature is dual-path: when `window.__TAURI__` is present it uses the Rust commands (see `services/discrepancy/nativeBridge.ts`); in dev/browser it falls back to the localhost Express server. Keep this pattern when adding features.
- **Credential embedding:** `src-tauri/build.rs` reads gitignored `src-tauri/.build-secrets.env` (template: `.build-secrets.env.example`) at compile time and embeds `EMBED_*` values via `rustc-env`/`option_env!`. When embedded, end users never see the Sending Settings card and the Slack token never reaches the frontend. Without the file, the app falls back to the in-app Sending Settings card (localStorage key `discrepancy_send_settings`). Dev mode reads `server/.env` instead.
- **Tauri v2 ACL gotcha:** every new `#[tauri::command]` MUST be allowed in `src-tauri/permissions/default.toml` (a `[[permission]]` block) AND listed in `src-tauri/capabilities/default.json`, or invoke fails at runtime with "Command X not allowed by ACL".

### Discrepancy Check-in (newest tool)

Web port of the Python `gck-discrepancy-checkin/daily_report.py` workflow: fetch DSP Discrepancy Report per publisher (PubMatic admin-custom-report API, T-3 data latency, 3 retries with backoff, concurrency 3) → standardize/filter/aggregate → structured summary + three report sections → send Email (HTML + CSV attachment) / Slack blocks via the server.

- `services/discrepancy/types.ts` — row types, `DISCREPANCY_CONFIG` (thresholds ±5%, report params), CSV column rename map.
- `services/discrepancy/dataProcessor.ts` — pandas logic ported to TS (percent normalization: raw values >1 are percent-points and get divided by 100).
- `services/discrepancy/apiService.ts` — fetch (Tauri: direct via `native_fetch`; dev: via proxy); `diagnoseError()` maps raw errors to human-readable causes for the Run Log.
- `services/discrepancy/nativeBridge.ts` — Tauri detection + wrappers for `native_fetch` / `send_email`.
- `services/discrepancy/defaults.ts` — built-in publisher ID list (165, from `GCK_Publisherlist_Monetizing.xlsx`) and default email recipients. Page edits persist to localStorage (`discrepancy_publisher_ids`, `discrepancy_email_recipients`); "Reset" restores these defaults. To permanently change defaults, edit this file.
- PubMatic tokens (Pubtoken/Bearer) are pasted per-session in the page and intentionally never persisted.

## Security Rules

- Never commit or hard-code tokens, passwords, or API keys. `server/.env` and `.env` are gitignored — keep it that way.
- Do not log or display secret values; mask them in UI (see `SecretInput` pattern).
- Keep the proxy URL whitelist (`ALLOWED_PATTERNS`) tight; add new domains deliberately, never wildcard.

## Gotchas

- `node_modules` contains macOS-arm64 native binaries (rollup, lightningcss, esbuild); builds only work on the machine that ran `npm install`.
- Global `express.json` limit is 25mb (email HTML + CSV attachments can be large) — don't reduce it.
- `apps.pubmatic.com` responses may be JSON **or** CSV; `apiService.ts` handles both.
- Vite dev runs on port 3000, proxy on 3001 (`VITE_PROXY_PORT` to override).
- Docs: this file is the architecture source of truth; `COMMANDS.md` covers build/distribution/git workflows; `CHANGELOG.md` is gitignored (kept locally/Obsidian).

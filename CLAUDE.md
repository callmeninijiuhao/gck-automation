# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**GCK Automation** (`pubmatic-validator-dashboard`) — internal dashboard for PubMatic's Publisher Development and Customer Success teams. React SPA + a local Express proxy/backend, packaged as a macOS desktop app with Tauri.

Five tools, grouped in the sidebar (`constants.tsx` → `NAV_STRUCTURE`):

| Section | Tool | Route | Page |
|---|---|---|---|
| PUB DEV | Pub Onboarding Validator | `/` | `pages/PubOnboardingValidator.tsx` |
| CUSTOMER SUCCESS | Top Bundle & Domain Analysis | `/top-bundle-analysis` | `pages/TopBundleAnalysis.tsx` |
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
- `services/discrepancy/llmReview.ts` — **advisory** AI Data Review (manual button in the results view). Runs *after* the deterministic checks and never replaces them: `detectAnomalies()` computes data-quality red flags in code (one-sided spend, spend-without-impressions, severe >50% discrepancy), then the Brain LLM triages plausibility and rates data health. The model is explicitly told the numbers are correct and must not recompute. On failure the page just shows a note — the report is unaffected. Page-only output (not in Email/Slack). Uses the shared `services/llm/brainClient.ts` (dev key from `server/.env`; desktop falls back to deterministic-only when no key).
- PubMatic tokens (Pubtoken/Bearer) are pasted per-session in the page and intentionally never persisted.

### Top Bundle & Domain Analysis

**Upload-based** (no live API). The user uploads the daily **Looker scheduled export** (CSV/Excel, already aggregated across DSPs); the tool maps columns, aggregates mobile in-app bundles / web+mweb / CTV, and produces an internal report + a partner-shareable bundle list. Replaces the former Domain Level Revenue Intelligence tool. Page `pages/TopBundleAnalysis.tsx`; services in `services/top-bundle/`.

> History: an earlier version fetched per-DSP from `apps.pubmatic.com/api/analytics/export/dsp/<id>`, but reports were 100k+ rows / multi-minute and the PubToken expired daily. Switched to Looker upload — Looker does the fetch/aggregate/schedule. The API path (`apiService.ts`, `cache.ts`) was removed.

- `fileParser.ts` — `parseFile` (CSV via papaparse / Excel via SheetJS) + `parseCsvText`; `autoMap()` matches headers to canonical fields via alias lists (Looker column names vary, so the page shows an editable mapping). `REQUIRED_FIELDS` = platform, spend, paidImpressions (+ bundle OR domain).
- `slackFetch.ts` — auto-fetch the latest Looker CSV posted to a Slack channel (Looker "Slack Attachment" schedule). Dual-path: dev → server `GET /api/slack/looker-latest?channel=&match=` (uses `SLACK_BOT_TOKEN`, does `files.list` → newest CSV → download `url_private_download`); desktop → same via `native_fetch` with the Slack token from Discrepancy Sending Settings. Bot needs `files:read` (+ `groups:history` for private) and must be in the channel. Manual upload stays as the fallback.
- `dataProcessor.ts` — `standardizeMapped(rows, mapping)` builds `BundleRow[]` from the field→column mapping; environment bucketing (`Platform` → in_app/mweb/web/ctv via `PLATFORM_BUCKETS`); `aggregate()`. **eCPM and bid rate are ratios — recomputed from summed totals, never summed/averaged.** iOS numeric bundles are enriched with the `Application` name. If the Looker `Platform` values differ from the expected bucket labels, in-app will be empty — the page logs the distinct Platform values so the buckets can be tuned.
- `reportBuilder.ts` — internal email HTML (spend + eCPM) + CSV builders.
- `llmService.ts` — AI narrative via the **PubMatic Brain API** (OpenAI-compatible chat). Dual-path like email: dev/browser POSTs to the server `/api/llm` (key in `server/.env` → `BRAIN_LLM_API_KEY`, endpoint `BRAIN_LLM_ENDPOINT`, default stage); desktop (Tauri) calls the Brain API directly via `native_fetch` with a key entered in the tool's LLM settings (localStorage, never in the bundle). Two instances: stage `stagellm.pubmatic.com` (non-prod keys, dev/CICD) and prod `llm.pubmatic.com`; non-prod → non-prod only. The model gets only compact summaries. On any failure the page falls back to `dataProcessor.generateStructuredSummary` (deterministic). The generic Brain transport/config (`chatComplete`, `LlmConfig`, `DEFAULT_LLM_CONFIG`, `BRAIN_MODELS`) lives in the shared `services/llm/brainClient.ts`; this file re-exports it and owns only the narrative prompt.
- `excelGenerator.ts` — multi-sheet workbook; raw data splits across sheets above Excel's row cap.
- **Email reuses the Discrepancy tool's validated path** (`discrepancy/backendService.sendEmail` + shared `discrepancy_send_settings`) — no separate email config. The **partner list** (bundles only — no spend/eCPM/DSP) is export-only; never auto-sent.

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

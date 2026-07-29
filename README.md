# GCK Automation

Internal dashboard for PubMatic's **Publisher Development** and **Customer Success** teams. React SPA + local Express backend (dev mode), packaged as a macOS desktop app with Tauri.

## Tools

| Section | Tool | What it does |
|---|---|---|
| PUB DEV | **Pub Onboarding Validator** | Crawls Google Play / App Store from a URL/Bundle ID, discovers the developer's apps, validates `app-ads.txt` against IAB standards |
| CUSTOMER SUCCESS | **Top Bundle & Domain Analysis** | Fetches top-DSP analytics exports; aggregates mobile in-app bundles, web/mweb & CTV; exports an internal report (spend + eCPM) and a clean, partner-shareable bundle list |
| CUSTOMER SUCCESS | **Seller Domain Shooter** | Searches a competitor's `sellers.json` for a publisher entity to verify supply path presence |
| CUSTOMER SUCCESS | **Auction Package Analyzer** | Audits publisher monetizing packages against wanted deal distributions |
| CUSTOMER SUCCESS | **Discrepancy Check-in** | Daily DSP Discrepancy report: fetch → aggregate → highlight ±5% → one-click Email + Slack. Replaces the Python `daily_report.py` workflow |
| API TOKEN | **Token Management** | Generate / refresh PubMatic API tokens |

## Tech Stack

React 19 · TypeScript 5.8 · Vite 6 · Tailwind v4 · React Router (HashRouter) · Tauri 2 (Rust) · Express (dev proxy)

## Quick Start

```bash
npm install && (cd server && npm install)

# Development (two terminals)
npm run proxy        # backend on :3001 — required in dev mode
npm run dev          # frontend on :3000

# Package the macOS app (no proxy needed at runtime)
npm run tauri:build
```

See **[COMMANDS.md](COMMANDS.md)** for the full build / distribution / git reference and **CLAUDE.md** for architecture details.

## Secrets

Never committed (gitignored): `server/.env` (dev-mode email/Slack), `src-tauri/.build-secrets.env` (credentials embedded into app builds). Templates: `*.example` files.

---
*Internal tool — v0.3.0*

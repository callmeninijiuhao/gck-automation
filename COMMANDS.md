# GCK Automation — Command Cheat Sheet

> Quick reference for daily dev, packaging, distribution, and git. Safe to copy into Obsidian.

## Daily Development

```bash
cd ~/gck-automation
npm run dev          # frontend dev server → http://localhost:3000
npm run proxy        # backend proxy (REQUIRED in dev mode) → http://localhost:3001
npx tsc --noEmit     # type check before committing
```

Dev mode reads Email/Slack secrets from `server/.env` (gitignored).

## Package the macOS App

```bash
cd ~/gck-automation
npm run tauri:build              # current arch (Apple Silicon on this Mac), ~2-3 min
npm run tauri:build:intel        # Intel Mac build (for Intel colleagues)
npm run tauri:build:arm64        # Apple Silicon build (explicit)
```

Outputs:

| Artifact | Path |
|---|---|
| App (for local testing) | `src-tauri/target/release/bundle/macos/GCK Automation.app` |
| DMG (for distribution) | `src-tauri/target/release/bundle/dmg/*.dmg` |

Version check: sidebar footer shows the version (currently **v0.3.0**). If the app "didn't change", you probably opened an old copy — quit it (Cmd+Q) and open the bundle path above.

⚠️ Before packaging, make sure `src-tauri/.build-secrets.env` exists (sender email/password + Slack bot token). It is embedded at compile time so end users don't configure anything. Changing it requires a rebuild.

Troubleshooting builds:

```bash
npm run clean:build              # clear build cache, keep node_modules
npm run clean && npm install     # nuclear option
```

## Distribute to Colleagues

1. Build the right arch (arm64 for M-series, intel for Intel Macs) — or build both.
2. Send the `.dmg` from `src-tauri/target/release/bundle/dmg/` (convention: copy into `release/`).
3. The app is **unsigned**, so on FIRST open macOS will block it. Tell colleagues to do this (one time only, no terminal needed):
   1. Double-click the app → a dialog says it can't be opened → click **Done/OK** (don't move it to Trash).
   2. Open **System Settings → Privacy & Security**, scroll down to *"GCK Automation" was blocked...*
   3. Click **Open Anyway**, then confirm **Open** (may ask for their Mac password).
   4. From then on the app opens normally by double-click.
4. Nothing else to install — no proxy, no Node, no config. Each user only pastes their own PubMatic Pubtoken/Bearer per session (they need PubMatic API access; Bearer can be generated in the app's Token Management page).

Per-user notes: publisher list & email recipients start from built-in defaults; each user's edits live in their own localStorage. All emails/Slack posts go out from the embedded shared account.

## Git

```bash
cd ~/gck-automation
git status                       # ALWAYS check secrets are not staged:
                                 #   server/.env, src-tauri/.build-secrets.env must NOT appear
git add -A
git commit -m "feat: Discrepancy Check-in tool (v0.3.0)"
git push origin main
```

Gitignored secrets (never commit): `server/.env`, `src-tauri/.build-secrets.env`, `.env`.
Committed templates: `server/.env.example`, `src-tauri/.build-secrets.env.example`.

New machine setup after cloning:

```bash
npm install && cd server && npm install && cd ..
cp server/.env.example server/.env                                  # fill in (dev mode)
cp src-tauri/.build-secrets.env.example src-tauri/.build-secrets.env # fill in (app builds)
```

## Adding a New Tauri Command (gotcha)

Every new `#[tauri::command]` in `src-tauri/src/lib.rs` needs THREE registrations, or it fails with `Command X not allowed by ACL`:

1. `tauri::generate_handler![...]` in `lib.rs`
2. A `[[permission]]` block in `src-tauri/permissions/default.toml`
3. The permission id added to `src-tauri/capabilities/default.json`

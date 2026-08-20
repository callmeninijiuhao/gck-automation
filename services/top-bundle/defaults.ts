// ─────────────────────────────────────────────
// Defaults: internal-report email recipients.
// The page lets you add/remove and persists changes to localStorage
// ("Reset" restores this list).
// ─────────────────────────────────────────────

// Same recipients as the Discrepancy Check-in tool (single source of truth) — the
// internal DoD Performance report reuses that tool's validated email path, so the two
// default lists stay identical. Re-exported so the page and the headless daily-brief
// job both use it.
export { DEFAULT_EMAIL_RECIPIENTS } from '../discrepancy/defaults';

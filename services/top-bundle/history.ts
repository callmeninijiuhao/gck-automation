// ─────────────────────────────────────────────
// Day-over-day history. Each analyzed day stores a compact snapshot of its top
// in-app rows (spend + PMR + rank) in localStorage, so the next run can diff
// against the most recent prior day.
//
// PMR (PubMatic revenue) is our team's KPI, so every day-over-day "status" and
// the displayed "vs prev" arrow are based on PMR. Spend is carried alongside for
// reference (some tables show a spend delta too).
// (Snapshots are small — top ~200 rows — so localStorage is fine.)
// ─────────────────────────────────────────────
import { AggRow } from './types';

// v2: bumped after the toNum scientific-notation fix so any pre-fix (inflated) snapshots
// are ignored rather than mixed into a day-over-day comparison. Bump again on any future
// parsing/aggregation change so stale caches auto-invalidate.
const KEY = 'top_bundle_history_v2';
const KEEP_ROWS = 200;   // store beyond top-50 so entries/exits near the cutoff are caught
const KEEP_DAYS = 60;

export type ChangeStatus = 'new' | 'up' | 'down' | 'flat';

/** Signed % change now-vs-prev with a small dead-band. `prev` undefined → 'new';
    non-positive prev → 'flat' with null delta (can't take a ratio). */
function delta(now: number, prev: number | undefined): { status: ChangeStatus; deltaPct: number | null } {
  if (prev === undefined) return { status: 'new', deltaPct: null };
  if (prev <= 0) return { status: 'flat', deltaPct: null };
  const d = (now - prev) / prev;
  return { status: Math.abs(d) < 0.02 ? 'flat' : d > 0 ? 'up' : 'down', deltaPct: d };
}

export interface BundleSnap { bundle: string; appName: string; spend: number; pmr: number; rank: number; }
type Store = Record<string, BundleSnap[]>;

function load(): Store {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function save(s: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota — ignore */ }
}

const toSnaps = (rows: AggRow[], n = KEEP_ROWS): BundleSnap[] =>
  rows.slice(0, n).map((b, i) => ({
    bundle: String(b.bundle ?? ''), appName: String(b.appName ?? ''), spend: b.spend, pmr: b.pmr, rank: i + 1,
  }));

export function saveSnapshot(date: string, topBundlesRanked: AggRow[]): void {
  const s = load();
  s[date] = toSnaps(topBundlesRanked);
  for (const d of Object.keys(s).sort().slice(0, Math.max(0, Object.keys(s).length - KEEP_DAYS))) delete s[d];
  save(s);
}

export function previousSnapshot(beforeDate: string): { date: string; snap: BundleSnap[] } | null {
  const s = load();
  const prior = Object.keys(s).filter((d) => d < beforeDate).sort();
  const d = prior[prior.length - 1];
  return d ? { date: d, snap: s[d] } : null;
}

export interface Mover { bundle: string; appName: string; from: number; to: number; delta: number; }
export interface DayOverDay {
  prevDate: string;
  topN: number;
  newEntrants: BundleSnap[];
  dropped: BundleSnap[];
  movers: Mover[];
}

/** Per-bundle change vs the prior snapshot. `status` follows PMR (our KPI). */
export interface BundleChange { status: ChangeStatus; pmrDeltaPct: number | null; spendDeltaPct: number | null; }

/** Per-bundle PMR/spend change vs the prior snapshot, keyed by bundle id.
    Empty map when there is no prior day (callers render "—"). */
export function bundleChangeMap(todayRanked: AggRow[], prev: { snap: BundleSnap[] } | null, topN = 50): Record<string, BundleChange> {
  const out: Record<string, BundleChange> = {};
  if (!prev) return out;
  const prevPmr = new Map(prev.snap.map((b) => [b.bundle, b.pmr]));
  const prevSpend = new Map(prev.snap.map((b) => [b.bundle, b.spend]));
  for (const b of todayRanked.slice(0, topN)) {
    const key = String(b.bundle ?? '');
    const dp = delta(b.pmr, prevPmr.get(key));
    const ds = delta(b.spend, prevSpend.get(key));
    out[key] = { status: dp.status, pmrDeltaPct: dp.deltaPct, spendDeltaPct: ds.deltaPct };
  }
  return out;
}

/** Plain-text arrow label for a bundle PMR change (Excel / non-HTML cells) —
    matches the ▲/▼ arrow style used in the on-screen and email tables. */
export function changeArrow(c: BundleChange | undefined): string {
  if (!c) return '—';
  if (c.status === 'new') return 'NEW';
  if (c.pmrDeltaPct === null) return '—';
  const p = Math.abs(Math.round(c.pmrDeltaPct * 100));
  if (c.status === 'up') return `▲ ${p}%`;
  if (c.status === 'down') return `▼ ${p}%`;
  return 'flat';
}

// ─────────────────────────────────────────────
// Publisher-level day-over-day. Same idea as the bundle snapshots, but keyed by
// publisher (our customers). `scope` keeps two independent histories:
//   'all' — overall market Top-N publishers ("大盘 Top 20")
//   'gck' — publishers belonging to the GCK POD only
// ─────────────────────────────────────────────
export type PubScope = 'all' | 'gck';
const PUB_KEYS: Record<PubScope, string> = {
  all: 'top_bundle_pub_history_v2',
  gck: 'top_bundle_gckpub_history_v2',
};
const KEEP_PUBS = 100;

export interface PubSnap { publisher: string; spend: number; pmr: number; rank: number; }
type PubStore = Record<string, PubSnap[]>;

function loadPub(scope: PubScope): PubStore {
  try { return JSON.parse(localStorage.getItem(PUB_KEYS[scope]) || '{}'); } catch { return {}; }
}
function savePub(scope: PubScope, s: PubStore): void {
  try { localStorage.setItem(PUB_KEYS[scope], JSON.stringify(s)); } catch { /* quota — ignore */ }
}

const toPubSnaps = (rows: AggRow[], n = KEEP_PUBS): PubSnap[] =>
  rows.slice(0, n).map((p, i) => ({ publisher: String(p.publisher ?? ''), spend: p.spend, pmr: p.pmr, rank: i + 1 }));

export function savePublisherSnapshot(date: string, publishersRanked: AggRow[], scope: PubScope = 'all'): void {
  const s = loadPub(scope);
  s[date] = toPubSnaps(publishersRanked);
  for (const d of Object.keys(s).sort().slice(0, Math.max(0, Object.keys(s).length - KEEP_DAYS))) delete s[d];
  savePub(scope, s);
}

export function previousPublisherSnapshot(beforeDate: string, scope: PubScope = 'all'): { date: string; snap: PubSnap[] } | null {
  const s = loadPub(scope);
  const prior = Object.keys(s).filter((d) => d < beforeDate).sort();
  const d = prior[prior.length - 1];
  return d ? { date: d, snap: s[d] } : null;
}

export interface PublisherChange {
  publisher: string;
  spend: number;
  pmr: number;
  status: ChangeStatus;           // based on PMR (our KPI)
  pmrDeltaPct: number | null;
  spendDeltaPct: number | null;
}

export interface PublisherDayOverDay {
  prevDate: string;
  topN: number;
  rows: PublisherChange[];
}

/** Diff today's top-N publishers against a prior snapshot (status follows PMR).
    Returns null when there is no prior day on record. */
export function diffPublishers(
  todayRanked: AggRow[],
  prev: { date: string; snap: PubSnap[] } | null,
  topN = 20,
): PublisherDayOverDay | null {
  if (!prev) return null;
  const prevPmr = new Map(prev.snap.map((p) => [p.publisher, p.pmr]));
  const prevSpend = new Map(prev.snap.map((p) => [p.publisher, p.spend]));
  const rows: PublisherChange[] = todayRanked.slice(0, topN).map((p) => {
    const key = String(p.publisher ?? '');
    const dp = delta(p.pmr, prevPmr.get(key));
    const ds = delta(p.spend, prevSpend.get(key));
    return { publisher: key, spend: p.spend, pmr: p.pmr, status: dp.status, pmrDeltaPct: dp.deltaPct, spendDeltaPct: ds.deltaPct };
  });
  return { prevDate: prev.date, topN, rows };
}

/** Diff today's ranked top-N in-app bundles against a prior snapshot (rank-based). */
export function diffTopN(todayRanked: AggRow[], prev: { date: string; snap: BundleSnap[] }, topN = 50): DayOverDay {
  const today = toSnaps(todayRanked, topN);
  const prevTop = prev.snap.slice(0, topN);
  const prevRank = new Map(prevTop.map((b) => [b.bundle, b.rank]));
  const todaySet = new Set(today.map((b) => b.bundle));
  const prevSet = new Set(prevTop.map((b) => b.bundle));

  const newEntrants = today.filter((b) => b.bundle && !prevSet.has(b.bundle));
  const dropped = prevTop.filter((b) => b.bundle && !todaySet.has(b.bundle));
  const movers = today
    .filter((b) => prevRank.has(b.bundle))
    .map((b) => ({ bundle: b.bundle, appName: b.appName, from: prevRank.get(b.bundle)!, to: b.rank, delta: prevRank.get(b.bundle)! - b.rank }))
    .filter((m) => Math.abs(m.delta) >= 3)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 15);

  return { prevDate: prev.date, topN, newEntrants, dropped, movers };
}

// ─────────────────────────────────────────────
// Generic named-dimension day-over-day (region / POD / DSP / country / ad format).
// One reusable snapshot store per dimension, keyed by a single "name" + spend + PMR,
// so any single-column aggregate can get a day-over-day trend without bespoke code.
// ─────────────────────────────────────────────
export interface DimChange {
  name: string;
  spend: number;
  pmr: number;
  status: ChangeStatus;           // based on PMR
  pmrDeltaPct: number | null;
  spendDeltaPct: number | null;
}
export interface DimDayOverDay { prevDate: string; topN: number; rows: DimChange[]; }

interface DimSnap { name: string; spend: number; pmr: number; }
type DimStore = Record<string, DimSnap[]>;
const dimKey = (dim: string) => `top_bundle_dim_${dim}_v2`;

function loadDim(dim: string): DimStore {
  try { return JSON.parse(localStorage.getItem(dimKey(dim)) || '{}'); } catch { return {}; }
}
function saveDimStore(dim: string, s: DimStore): void {
  try { localStorage.setItem(dimKey(dim), JSON.stringify(s)); } catch { /* quota — ignore */ }
}

/** Snapshot today's ranked aggregate for a dimension, keyed by `nameKey` (e.g. 'region'). */
export function saveDimSnapshot(dim: string, date: string, ranked: AggRow[], nameKey: keyof AggRow, keep = 60): void {
  const s = loadDim(dim);
  s[date] = ranked.slice(0, keep).map((r) => ({ name: String(r[nameKey] ?? ''), spend: r.spend, pmr: r.pmr }));
  for (const d of Object.keys(s).sort().slice(0, Math.max(0, Object.keys(s).length - KEEP_DAYS))) delete s[d];
  saveDimStore(dim, s);
}

export function previousDimSnapshot(dim: string, beforeDate: string): { date: string; snap: DimSnap[] } | null {
  const s = loadDim(dim);
  const prior = Object.keys(s).filter((d) => d < beforeDate).sort();
  const d = prior[prior.length - 1];
  return d ? { date: d, snap: s[d] } : null;
}

/** Diff today's ranked top-N against a prior dimension snapshot (status follows PMR). Null when no prior day. */
export function diffDim(
  todayRanked: AggRow[], prev: { date: string; snap: DimSnap[] } | null, nameKey: keyof AggRow, topN = 10,
): DimDayOverDay | null {
  if (!prev) return null;
  const prevPmr = new Map(prev.snap.map((p) => [p.name, p.pmr]));
  const prevSpend = new Map(prev.snap.map((p) => [p.name, p.spend]));
  const rows: DimChange[] = todayRanked.slice(0, topN).map((r) => {
    const name = String(r[nameKey] ?? '');
    const dp = delta(r.pmr, prevPmr.get(name));
    const ds = delta(r.spend, prevSpend.get(name));
    return { name, spend: r.spend, pmr: r.pmr, status: dp.status, pmrDeltaPct: dp.deltaPct, spendDeltaPct: ds.deltaPct };
  });
  return { prevDate: prev.date, topN, rows };
}

/** Look up a single row's change inside a DimDayOverDay by name (for group-row "vs prev"). */
export function dimChangeOf(dod: DimDayOverDay | null, name: string): DimChange | undefined {
  return dod?.rows.find((r) => r.name === name);
}

// ─────────────────────────────────────────────
// Daily totals — a tiny store of the headline in-app numbers per day, so the
// executive summary can state an EXACT overall day-over-day % (the top-N dimension
// snapshots only cover the top rows, which would understate the true total).
// ─────────────────────────────────────────────
const TOTALS_KEY = 'top_bundle_totals_v2';
export interface DailyTotals { inAppSpend: number; pmr: number; revenue: number; }

export function saveDailyTotals(date: string, t: DailyTotals): void {
  try {
    const s: Record<string, DailyTotals> = JSON.parse(localStorage.getItem(TOTALS_KEY) || '{}');
    s[date] = t;
    for (const d of Object.keys(s).sort().slice(0, Math.max(0, Object.keys(s).length - KEEP_DAYS))) delete s[d];
    localStorage.setItem(TOTALS_KEY, JSON.stringify(s));
  } catch { /* quota — ignore */ }
}

export function previousDailyTotals(beforeDate: string): { date: string; totals: DailyTotals } | null {
  try {
    const s: Record<string, DailyTotals> = JSON.parse(localStorage.getItem(TOTALS_KEY) || '{}');
    const prior = Object.keys(s).filter((d) => d < beforeDate).sort();
    const d = prior[prior.length - 1];
    return d ? { date: d, totals: s[d] } : null;
  } catch { return null; }
}

export interface OverallDoD {
  prevDate: string;
  spendDeltaPct: number | null;
  pmrDeltaPct: number | null;
}

/** Overall in-app day-over-day from the stored daily totals. Null when no prior day. */
export function overallDayOverDay(today: DailyTotals, prev: { date: string; totals: DailyTotals } | null): OverallDoD | null {
  if (!prev) return null;
  const pct = (now: number, was: number) => (was > 0 ? (now - was) / was : null);
  return {
    prevDate: prev.date,
    spendDeltaPct: pct(today.inAppSpend, prev.totals.inAppSpend),
    pmrDeltaPct: pct(today.pmr, prev.totals.pmr),
  };
}

// ─────────────────────────────────────────────
// Everything the executive summary / narrative / watch-list needs to attribute
// movement. All fields are null on a baseline (first) run — callers degrade gracefully.
// ─────────────────────────────────────────────
export interface DoDContext {
  overall: OverallDoD | null;
  bundle: DayOverDay | null;
  publishers: PublisherDayOverDay | null;     // overall Top-N
  gckPublishers: PublisherDayOverDay | null;   // GCK POD Top-N
  gckBundles: DimDayOverDay | null;            // GCK POD bundles (keyed by app name)
  region: DimDayOverDay | null;
  pod: DimDayOverDay | null;
  dsp: DimDayOverDay | null;
  country: DimDayOverDay | null;
  adFormat: DimDayOverDay | null;
}

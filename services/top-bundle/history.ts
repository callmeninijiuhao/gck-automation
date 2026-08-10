// ─────────────────────────────────────────────
// Day-over-day history. Each analyzed day stores a compact snapshot of its top
// in-app bundles (bundle + spend + rank) in localStorage, so the next run can
// diff against the most recent prior day: new entrants / dropped / rank movers.
// (Snapshots are small — top ~200 bundles — so localStorage is fine.)
// ─────────────────────────────────────────────
import { AggRow } from './types';

const KEY = 'top_bundle_history_v1';
const KEEP_ROWS = 200;   // store beyond top-50 so entries/exits near the cutoff are caught
const KEEP_DAYS = 60;

export interface BundleSnap { bundle: string; appName: string; spend: number; rank: number; }
type Store = Record<string, BundleSnap[]>;

function load(): Store {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function save(s: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota — ignore */ }
}

const toSnaps = (rows: AggRow[], n = KEEP_ROWS): BundleSnap[] =>
  rows.slice(0, n).map((b, i) => ({
    bundle: String(b.bundle ?? ''), appName: String(b.appName ?? ''), spend: b.spend, rank: i + 1,
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

export interface BundleChange { status: 'new' | 'up' | 'down' | 'flat'; spendDeltaPct: number | null; }

/** Per-bundle spend change vs the prior snapshot, keyed by bundle id.
    Empty map when there is no prior day (callers render "—"). */
export function bundleChangeMap(todayRanked: AggRow[], prev: { snap: BundleSnap[] } | null, topN = 50): Record<string, BundleChange> {
  const out: Record<string, BundleChange> = {};
  if (!prev) return out;
  const prevSpend = new Map(prev.snap.map((b) => [b.bundle, b.spend]));
  for (const b of todayRanked.slice(0, topN)) {
    const key = String(b.bundle ?? '');
    const ps = prevSpend.get(key);
    if (ps === undefined) { out[key] = { status: 'new', spendDeltaPct: null }; continue; }
    if (ps <= 0) { out[key] = { status: 'flat', spendDeltaPct: null }; continue; }
    const d = (b.spend - ps) / ps;
    out[key] = { status: Math.abs(d) < 0.02 ? 'flat' : d > 0 ? 'up' : 'down', spendDeltaPct: d };
  }
  return out;
}

/** Text label for a bundle change (email/excel/UI). */
export function changeLabel(c: BundleChange | undefined): string {
  if (!c) return '—';
  if (c.status === 'new') return 'new';
  if (c.spendDeltaPct === null) return '—';
  const p = Math.round(c.spendDeltaPct * 100);
  if (c.status === 'up') return `up ${p}%`;
  if (c.status === 'down') return `down ${Math.abs(p)}%`;
  return 'flat';
}

// ─────────────────────────────────────────────
// Publisher-level day-over-day. Same idea as the bundle snapshots, but keyed by
// publisher (our customers) instead of bundle — easier to read at a glance since
// a bundle alone doesn't tell you which publisher it belongs to.
// ─────────────────────────────────────────────
const PUB_KEY = 'top_bundle_pub_history_v1';
const KEEP_PUBS = 100;

export interface PubSnap { publisher: string; spend: number; rank: number; }
type PubStore = Record<string, PubSnap[]>;

function loadPub(): PubStore {
  try { return JSON.parse(localStorage.getItem(PUB_KEY) || '{}'); } catch { return {}; }
}
function savePub(s: PubStore): void {
  try { localStorage.setItem(PUB_KEY, JSON.stringify(s)); } catch { /* quota — ignore */ }
}

const toPubSnaps = (rows: AggRow[], n = KEEP_PUBS): PubSnap[] =>
  rows.slice(0, n).map((p, i) => ({ publisher: String(p.publisher ?? ''), spend: p.spend, rank: i + 1 }));

export function savePublisherSnapshot(date: string, publishersRanked: AggRow[]): void {
  const s = loadPub();
  s[date] = toPubSnaps(publishersRanked);
  for (const d of Object.keys(s).sort().slice(0, Math.max(0, Object.keys(s).length - KEEP_DAYS))) delete s[d];
  savePub(s);
}

export function previousPublisherSnapshot(beforeDate: string): { date: string; snap: PubSnap[] } | null {
  const s = loadPub();
  const prior = Object.keys(s).filter((d) => d < beforeDate).sort();
  const d = prior[prior.length - 1];
  return d ? { date: d, snap: s[d] } : null;
}

export interface PublisherChange {
  publisher: string;
  spend: number;
  status: 'new' | 'up' | 'down' | 'flat';
  spendDeltaPct: number | null;   // null for new / no prior spend
}

export interface PublisherDayOverDay {
  prevDate: string;
  topN: number;
  rows: PublisherChange[];
}

/** Diff today's top-N publishers by spend against a prior snapshot.
    Returns null when there is no prior day on record. */
export function diffPublishers(
  todayRanked: AggRow[],
  prev: { date: string; snap: PubSnap[] } | null,
  topN = 20,
): PublisherDayOverDay | null {
  if (!prev) return null;
  const prevSpend = new Map(prev.snap.map((p) => [p.publisher, p.spend]));
  const rows: PublisherChange[] = todayRanked.slice(0, topN).map((p) => {
    const key = String(p.publisher ?? '');
    const ps = prevSpend.get(key);
    if (ps === undefined) return { publisher: key, spend: p.spend, status: 'new', spendDeltaPct: null };
    if (ps <= 0) return { publisher: key, spend: p.spend, status: 'flat', spendDeltaPct: null };
    const d = (p.spend - ps) / ps;
    return { publisher: key, spend: p.spend, status: Math.abs(d) < 0.02 ? 'flat' : d > 0 ? 'up' : 'down', spendDeltaPct: d };
  });
  return { prevDate: prev.date, topN, rows };
}

/** Diff today's ranked top-N in-app bundles against a prior snapshot. */
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

// ─────────────────────────────────────────────
// Normalize, split by environment, aggregate.
//
// CRITICAL: eCPM and bid rate are RATIOS. They are never summed or averaged.
// After summing the additive metrics (spend, impressions, bids), the ratios are
// recomputed from the summed totals — see recomputeRatios().
// ─────────────────────────────────────────────
import {
  AggRow, BundleRow, Environment, NA_TOKENS, PLATFORM_BUCKETS, PartnerRow,
  TOP_BUNDLE_CONFIG,
} from './types';
import type { DoDContext, DimDayOverDay, PublisherDayOverDay } from './history';

/** field name → source column header (from the upload mapping UI). */
export type FieldMapping = Record<string, string | undefined>;

// ── formatting helpers ──
export const fmtNum = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n)
    ? 'N/A'
    : Math.round(n).toLocaleString('en-US');

export const fmtCurrency = (n: number): string =>
  `$${(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtEcpm = (n: number): string => `$${(n ?? 0).toFixed(2)}`;

export const fmtPct = (frac: number): string => `${((frac ?? 0) * 100).toFixed(1)}%`;

// ── value coercion ──
const isNa = (v: unknown): boolean =>
  v === null || v === undefined || NA_TOKENS.has(String(v).trim().toLowerCase());

const cleanStr = (v: unknown): string | undefined => (isNa(v) ? undefined : String(v).trim());

/** Parse Looker-style numbers: "$32.06 K" → 32060, "$0.9158" → 0.9158, "(1,234)" → -1234,
    and scientific notation "7.5E-5" → 0.000075 (Looker exports tiny sub-cent values this way). */
const toNum = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()$,\s]/g, '');
  // Capture an optional exponent so "7.5E-5" isn't truncated to 7.5.
  const m = s.match(/^-?\d*\.?\d+(?:[eE][+-]?\d+)?/);
  if (!m) return 0;
  let n = parseFloat(m[0]);
  if (!Number.isFinite(n)) return 0;
  const suffix = s.slice(m[0].length, m[0].length + 1).toLowerCase();
  if (suffix === 'k') n *= 1e3;
  else if (suffix === 'm') n *= 1e6;
  else if (suffix === 'b') n *= 1e9;
  return neg ? -n : n;
};

function bucketPlatform(platform: string): Environment {
  const p = platform.trim().toLowerCase(); // case-insensitive: "Mobile App IOS" == "Mobile App iOS"
  for (const env of Object.keys(PLATFORM_BUCKETS) as (keyof typeof PLATFORM_BUCKETS)[]) {
    if (PLATFORM_BUCKETS[env].some((v) => v.toLowerCase() === p)) return env;
  }
  return 'other';
}

/** iOS bundles are numeric App Store ids → Application carries the name.
    Android bundles are already reverse-domain readable. */
function appNameOf(application?: string, bundle?: string, domain?: string): string {
  return application ?? bundle ?? domain ?? 'Unknown';
}

/** Build BundleRow[] from arbitrary source rows using a field→sourceHeader mapping.
    Rows with no Platform value are skipped (Looker totals / blank trailing rows). */
export function standardizeMapped(raw: Record<string, unknown>[], mapping: FieldMapping): BundleRow[] {
  const get = (rec: Record<string, unknown>, field: string) => {
    const h = mapping[field];
    return h ? rec[h] : undefined;
  };
  const out: BundleRow[] = [];
  const bundleHeader = String(mapping.bundle ?? '').trim().toLowerCase();
  for (const rec of raw) {
    // Skip Looker's trailing footer / repeated-header line: its bundle cell literally
    // echoes the column header (e.g. "domain" under the "domain" column, with a "dt"
    // date and blank metrics). No real bundle equals its own header name, so this is a
    // strict no-op for files that have no such footer row.
    if (bundleHeader && String(get(rec, 'bundle') ?? '').trim().toLowerCase() === bundleHeader) continue;
    const platform = cleanStr(get(rec, 'platform')) ?? '';
    if (!platform) continue;
    const bundle = cleanStr(get(rec, 'bundle'));
    const application = cleanStr(get(rec, 'application'));
    const spend = toNum(get(rec, 'spend'));
    const pmr = toNum(get(rec, 'pmr'));
    const revenue = toNum(get(rec, 'revenue'));
    const ecpm = toNum(get(rec, 'ecpm'));
    // Use a mapped Impressions column if present; otherwise derive from spend ÷ eCPM
    // so aggregated eCPM (= totalSpend / totalImpr × 1000) is still correct.
    const rawImpr = get(rec, 'paidImpressions');
    const paidImpressions = (rawImpr !== undefined && rawImpr !== null && String(rawImpr).trim() !== '')
      ? toNum(rawImpr)
      : (ecpm > 0 ? (spend / ecpm) * 1000 : 0);
    out.push({
      publisherId: cleanStr(get(rec, 'publisherId')),
      publisher: cleanStr(get(rec, 'publisher')),
      platform,
      adFormat: cleanStr(get(rec, 'adFormat')),
      adSize: cleanStr(get(rec, 'adSize')),
      country: cleanStr(get(rec, 'country')),
      dsp: cleanStr(get(rec, 'dsp')),
      region: cleanStr(get(rec, 'region')),
      pod: cleanStr(get(rec, 'pod')),
      date: cleanStr(get(rec, 'date')),
      application,
      bundle,
      spend,
      pmr,
      revenue,
      paidImpressions,
      ecpm,
      nonZeroBidResponses: 0,
      totalBidRequests: 0,
      environment: bucketPlatform(platform),
      appName: appNameOf(application, bundle),
    });
  }
  return out;
}

// ── environment slices ──
export const inApp = (rows: BundleRow[]) => rows.filter((r) => r.environment === 'in_app');
export const webMweb = (rows: BundleRow[]) => rows.filter((r) => r.environment === 'web' || r.environment === 'mweb');
export const ctv = (rows: BundleRow[]) => rows.filter((r) => r.environment === 'ctv');

function recomputeRatios(a: AggRow): void {
  a.ecpm = a.paidImpressions > 0 ? (a.spend / a.paidImpressions) * 1000 : 0;
  a.bidRate = a.totalBidRequests > 0 ? a.nonZeroBidResponses / a.totalBidRequests : 0;
}

/** Sum additive metrics grouped by `keys`, then recompute eCPM/bidRate. Sorted by spend desc. */
export function aggregate(rows: BundleRow[], keys: (keyof BundleRow)[]): AggRow[] {
  const map = new Map<string, AggRow>();
  for (const r of rows) {
    const k = keys.map((key) => String((r as any)[key] ?? '')).join('||');
    let agg = map.get(k);
    if (!agg) {
      agg = { spend: 0, pmr: 0, revenue: 0, paidImpressions: 0, nonZeroBidResponses: 0, totalBidRequests: 0, ecpm: 0, bidRate: 0 };
      for (const key of keys) (agg as any)[key] = (r as any)[key] ?? '';
      map.set(k, agg);
    }
    agg.spend += r.spend;
    agg.pmr += r.pmr;
    agg.revenue += r.revenue;
    agg.paidImpressions += r.paidImpressions;
    agg.nonZeroBidResponses += r.nonZeroBidResponses;
    agg.totalBidRequests += r.totalBidRequests;
  }
  const out = [...map.values()];
  out.forEach(recomputeRatios);
  return out.sort((x, y) => y.spend - x.spend);
}

// ── report tables ──
export const topBundles = (rows: BundleRow[], n: number = TOP_BUNDLE_CONFIG.topBundles) =>
  aggregate(inApp(rows), ['bundle', 'appName', 'platform']).slice(0, n);

export function bundleByAdFormat(rows: BundleRow[], limitToTop = true): AggRow[] {
  let sub = inApp(rows);
  if (limitToTop) {
    const top = new Set(topBundles(rows).map((b) => b.bundle));
    sub = sub.filter((r) => top.has(r.bundle));
  }
  return aggregate(sub, ['bundle', 'appName', 'adFormat']);
}

export function bundleByPublisher(rows: BundleRow[], limitToTop = true): AggRow[] {
  let sub = inApp(rows);
  if (limitToTop) {
    const top = new Set(topBundles(rows).map((b) => b.bundle));
    sub = sub.filter((r) => top.has(r.bundle));
  }
  return aggregate(sub, ['bundle', 'appName', 'publisher']);
}

/** Top publishers (our customers) by in-app spend. */
export const topPublishers = (rows: BundleRow[], n = 20) =>
  aggregate(inApp(rows), ['publisher']).slice(0, n);

/** Whether a POD label belongs to the GCK POD (matched loosely — the Looker POD
    value may read "GCK", "GCK POD", "APAC-GCK", etc.). */
export const isGckPod = (pod?: string): boolean => /gck/i.test(String(pod ?? ''));

/** GCK POD top publishers by in-app spend (rows whose POD matches isGckPod). */
export const gckPublishers = (rows: BundleRow[], n = 20) =>
  aggregate(inApp(rows).filter((r) => isGckPod(r.pod)), ['publisher']).slice(0, n);

/** GCK POD top bundles (keyed by app name for readability), for the GCK deep-dive. */
export const gckBundles = (rows: BundleRow[], n = 30) =>
  aggregate(inApp(rows).filter((r) => isGckPod(r.pod)), ['appName']).slice(0, n);

// ── Top DSPs, each with their top bundles (Top 10 DSP → Top 5 bundles) ──
export interface DspBundleRow { bundle: string; appName: string; platform: string; spend: number; pmr: number; ecpm: number; spendShareOfDsp: number; pmrShareOfDsp: number; }
export interface DspGroup { dsp: string; spend: number; pmr: number; ecpm: number; spendShare: number; pmrShare: number; rows: DspBundleRow[]; }

export function dspWithBundles(rows: BundleRow[], nDsp = 10, nBundle = 5): DspGroup[] {
  const ia = inApp(rows);
  const totalSpend = sumSpend(ia);
  const totalPmr = sumPmr(ia);
  return aggregate(ia, ['dsp']).slice(0, nDsp).map((d) => {
    const sub = ia.filter((r) => (r.dsp ?? '') === (d.dsp ?? ''));
    const rws = aggregate(sub, ['bundle', 'appName', 'platform']).slice(0, nBundle).map((b) => ({
      bundle: String(b.bundle ?? ''), appName: String(b.appName ?? ''), platform: String(b.platform ?? ''),
      spend: b.spend, pmr: b.pmr, ecpm: b.ecpm,
      spendShareOfDsp: d.spend > 0 ? b.spend / d.spend : 0,
      pmrShareOfDsp: d.pmr > 0 ? b.pmr / d.pmr : 0,
    }));
    return {
      dsp: String(d.dsp ?? '') || '(none)', spend: d.spend, pmr: d.pmr, ecpm: d.ecpm,
      spendShare: totalSpend > 0 ? d.spend / totalSpend : 0, pmrShare: totalPmr > 0 ? d.pmr / totalPmr : 0, rows: rws,
    };
  });
}

// ── Ad format → size pivot (in-app) ──
export interface AdSizeRow { adSize: string; spend: number; pmr: number; ecpm: number; spendShareOfFormat: number; pmrShareOfFormat: number; }
export interface AdFormatGroup { adFormat: string; spend: number; pmr: number; ecpm: number; spendShare: number; pmrShare: number; sizes: AdSizeRow[]; }

export function adFormatPivot(rows: BundleRow[], displayMaxSizes = 5): AdFormatGroup[] {
  const ia = inApp(rows);
  const totalSpend = sumSpend(ia);
  const totalPmr = sumPmr(ia);
  return aggregate(ia, ['adFormat']).map((f) => {
    const fmt = String(f.adFormat ?? '') || '(none)';
    const allSizes = aggregate(ia.filter((r) => (r.adFormat ?? '') === (f.adFormat ?? '')), ['adSize'])
      .map((s) => ({
        adSize: String(s.adSize ?? '') || '(none)', spend: s.spend, pmr: s.pmr, ecpm: s.ecpm,
        spendShareOfFormat: f.spend > 0 ? s.spend / f.spend : 0,
        pmrShareOfFormat: f.pmr > 0 ? s.pmr / f.pmr : 0,
      }));
    // Display carries many sizes — cap to the top few (already sorted by spend desc).
    const sizes = /display/i.test(fmt) ? allSizes.slice(0, displayMaxSizes) : allSizes;
    return {
      adFormat: fmt, spend: f.spend, pmr: f.pmr, ecpm: f.ecpm,
      spendShare: totalSpend > 0 ? f.spend / totalSpend : 0, pmrShare: totalPmr > 0 ? f.pmr / totalPmr : 0, sizes,
    };
  });
}

// ── Top bundles broken down by their top publishers (formats merged into a list) ──
export interface BundlePubRow { publisher: string; formats: string[]; spend: number; pmr: number; ecpm: number; spendShareOfBundle: number; pmrShareOfBundle: number; }
export interface BundleGroup {
  bundle: string; appName: string; platform: string; spend: number; pmr: number; ecpm: number; spendShare: number; pmrShare: number;
  rows: BundlePubRow[];
}

export function bundlePublisherBreakdown(rows: BundleRow[], n = 20, topPub = 3): BundleGroup[] {
  const ia = inApp(rows);
  const totalSpend = sumSpend(ia);
  const totalPmr = sumPmr(ia);
  return aggregate(ia, ['bundle', 'appName', 'platform']).slice(0, n).map((b) => {
    const sub = ia.filter((r) => (r.bundle ?? '') === (b.bundle ?? ''));
    const rws = aggregate(sub, ['publisher']).slice(0, topPub).map((p) => {
      const formats = [...new Set(sub.filter((r) => (r.publisher ?? '') === (p.publisher ?? '')).map((r) => r.adFormat).filter(Boolean))] as string[];
      return {
        publisher: String(p.publisher ?? '') || '(unknown)',
        formats, spend: p.spend, pmr: p.pmr, ecpm: p.ecpm,
        spendShareOfBundle: b.spend > 0 ? p.spend / b.spend : 0,
        pmrShareOfBundle: b.pmr > 0 ? p.pmr / b.pmr : 0,
      };
    });
    return {
      bundle: String(b.bundle ?? ''), appName: String(b.appName ?? ''), platform: String(b.platform ?? ''),
      spend: b.spend, pmr: b.pmr, ecpm: b.ecpm,
      spendShare: totalSpend > 0 ? b.spend / totalSpend : 0, pmrShare: totalPmr > 0 ? b.pmr / totalPmr : 0, rows: rws,
    };
  });
}

// ── extra in-app dimension breakdowns (Android + iOS focus) ──
export const byDsp = (rows: BundleRow[], n = 20) =>
  aggregate(inApp(rows), ['dsp']).slice(0, n);

export const byAdFormatSize = (rows: BundleRow[], n = 30) =>
  aggregate(inApp(rows), ['adFormat', 'adSize']).slice(0, n);

export const byAdFormat = (rows: BundleRow[], n = 30) =>
  aggregate(inApp(rows), ['adFormat']).slice(0, n);

export const byCountry = (rows: BundleRow[], n = 30) =>
  aggregate(inApp(rows), ['country']).slice(0, n);

// Drop rows whose Region/POD is blank in the Looker export (unclassified tail,
// negligible spend). Filter before slicing so the Top-N counts real PODs.
export const byRegion = (rows: BundleRow[]) =>
  aggregate(inApp(rows), ['region']).filter((r) => String(r.region ?? '').trim() !== '');

export const byPod = (rows: BundleRow[], n = 30) =>
  aggregate(inApp(rows), ['pod', 'region']).filter((r) => String(r.pod ?? '').trim() !== '').slice(0, n);

export const topDomains = (rows: BundleRow[], n: number = TOP_BUNDLE_CONFIG.topDomains) =>
  aggregate(webMweb(rows), ['domain', 'platform', 'publisher']).slice(0, n);

export const ctvSummary = (rows: BundleRow[], n: number = TOP_BUNDLE_CONFIG.topDomains) =>
  aggregate(ctv(rows), ['domain', 'publisher', 'adFormat']).slice(0, n);

/** In-app bundle × country list to share with partners. Includes eCPM (for their
    reference) and country (so partners send the right geo); NO spend/DSP data.
    Ranked by spend internally; top `n` (default 500). */
export function partnerList(rows: BundleRow[], n = 500): PartnerRow[] {
  return aggregate(inApp(rows), ['bundle', 'appName', 'platform', 'country'])
    .filter((a) => String(a.bundle ?? '').trim())
    .slice(0, n)
    .map((a) => ({
      bundle: String(a.bundle ?? ''),
      appName: String(a.appName ?? a.bundle ?? ''),
      platform: String(a.platform ?? ''),
      country: String(a.country ?? ''),
      ecpm: a.ecpm,
    }));
}

// ── headline metrics ──
export interface AnalysisMetrics {
  totalSpend: number;
  inAppSpend: number;
  webSpend: number;
  ctvSpend: number;
  inAppShare: number;      // fraction
  totalPmr: number;        // PubMatic revenue (all rows)
  inAppPmr: number;        // PubMatic revenue (in-app only) — base for PMR contribution %
  totalRevenue: number;    // publisher revenue (all rows)
  distinctBundles: number;
  distinctDomains: number;
  ctvEcpm: number;
  topBundleName: string;
  topBundleSpend: number;
}

const sumSpend = (rows: BundleRow[]) => rows.reduce((s, r) => s + r.spend, 0);
const sumPmr = (rows: BundleRow[]) => rows.reduce((s, r) => s + r.pmr, 0);

export function computeMetrics(rows: BundleRow[]): AnalysisMetrics {
  const tb = topBundles(rows, 1)[0];
  const ctvRows = ctv(rows);
  const ctvSpend = sumSpend(ctvRows);
  const ctvImps = ctvRows.reduce((s, r) => s + r.paidImpressions, 0);
  const totalSpend = sumSpend(rows);
  const inAppSpend = sumSpend(inApp(rows));
  return {
    totalSpend,
    inAppSpend,
    webSpend: sumSpend(webMweb(rows)),
    ctvSpend,
    inAppShare: totalSpend > 0 ? inAppSpend / totalSpend : 0,
    totalPmr: sumPmr(rows),
    inAppPmr: sumPmr(inApp(rows)),
    totalRevenue: rows.reduce((s, r) => s + r.revenue, 0),
    distinctBundles: new Set(inApp(rows).map((r) => r.bundle)).size,
    distinctDomains: new Set(webMweb(rows).map((r) => r.domain)).size,
    ctvEcpm: ctvImps > 0 ? (ctvSpend / ctvImps) * 1000 : 0,
    topBundleName: tb ? String(tb.appName ?? tb.bundle) : 'N/A',
    topBundleSpend: tb ? tb.spend : 0,
  };
}

// ── deterministic executive-summary helpers (PMR-based DoD attribution) ──
const roundPct = (frac: number) => Math.round(frac * 100);
/** Signed % (e.g. "+12%", "-8%"). '' when null. Kept signed so renderers can colour it.
    Once |Δ| rounds to ≥1% it shows a whole number; smaller-but-nonzero moves show up to
    2 decimals so a tiny change isn't flattened to a misleading "0%" (e.g. "-0.02%"). */
const signed = (frac: number | null): string => {
  if (frac === null) return '';
  const pct = frac * 100;
  const r = Math.round(pct);
  if (r !== 0) return `${r > 0 ? '+' : ''}${r}%`;
  if (Math.abs(pct) < 0.005) return '0%';   // genuinely negligible
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
};

/** Single most likely PMR driver for the opening line: top publisher gainer, else top POD/region gainer. */
function leadDriver(dod?: DoDContext | null): string {
  if (!dod) return '';
  const pubUp = dod.publishers?.rows
    .filter((r) => r.status === 'up' && r.pmrDeltaPct !== null)
    .sort((a, b) => b.pmrDeltaPct! - a.pmrDeltaPct!)[0];
  if (pubUp) return `${pubUp.publisher} (${signed(pubUp.pmrDeltaPct)})`;
  const pickDim = (d: DimDayOverDay | null | undefined, tmpl: (n: string, s: string) => string): string => {
    const up = d?.rows
      .filter((r) => r.status === 'up' && r.pmrDeltaPct !== null)
      .sort((a, b) => b.pmrDeltaPct! - a.pmrDeltaPct!)[0];
    return up ? tmpl(up.name, signed(up.pmrDeltaPct)) : '';
  };
  return pickDim(dod.pod, (n, s) => `the ${n} POD (${s})`) || pickDim(dod.region, (n, s) => `${n} (${s})`);
}

/**
 * Deterministic executive summary (no LLM) — the fallback when the AI narrative is
 * unavailable. Grouped for scannability: an "Executive Summary" heading, a one-line
 * tone intro, then short topic categories (Overall → By Region → By POD → By Publisher →
 * GCK POD) each with a couple of concise "• " sub-bullets. PMR (PubMatic revenue) leads
 * every data point, annotated with its signed day-over-day change so renderers can
 * colour ▲/▼. Highlights only — the tables below carry the full detail. Neutral wording.
 */
export function generateStructuredSummary(rows: BundleRow[], dateLabel: string, dod?: DoDContext | null): string {
  const m = computeMetrics(rows);
  const pmrShare = (v: number) => fmtPct(m.inAppPmr > 0 ? v / m.inAppPmr : 0);
  const reg = byRegion(rows);
  const tp = topPublishers(rows, 5);
  const gckPmr = sumPmr(inApp(rows).filter((r) => isGckPod(r.pod)));
  const dimSign = (d: DimDayOverDay | null | undefined, name: string) => {
    const r = d?.rows.find((x) => x.name === name);
    return r?.pmrDeltaPct != null ? ` (${signed(r.pmrDeltaPct)})` : '';
  };
  const pubSign = (d: PublisherDayOverDay | null | undefined, pub: string) => {
    const r = d?.rows.find((x) => x.publisher === pub);
    return r?.pmrDeltaPct != null ? ` (${signed(r.pmrDeltaPct)})` : '';
  };
  // DSP-spend deltas (secondary but daily-watched metric) — shown alongside PMR.
  const dimSpendSign = (d: DimDayOverDay | null | undefined, name: string) => {
    const r = d?.rows.find((x) => x.name === name);
    return r?.spendDeltaPct != null ? ` (${signed(r.spendDeltaPct)})` : '';
  };
  const overall = dod?.overall ?? null;
  const L: string[] = ['Executive Summary'];

  // One-line tone intro (paragraph, not a bullet).
  if (overall && overall.pmrDeltaPct !== null) {
    const p = roundPct(overall.pmrDeltaPct);
    const tone = p >= 1
      ? `Today is a good day — overall PMR grew +${p}% vs ${overall.prevDate}`
      : p <= -1
        ? `A steady day — overall PMR saw a ${p}% adjustment vs ${overall.prevDate}`
        : `A stable day — overall PMR held roughly flat vs ${overall.prevDate}`;
    const driver = leadDriver(dod);
    const spDelta = overall.spendDeltaPct != null ? `; DSP spend ${signed(overall.spendDeltaPct)}` : '';
    L.push(`${tone}${spDelta}${driver ? `, led mainly by ${driver}` : ''}.`);
  } else {
    L.push(`Baseline day for ${dateLabel} — first run on record; today sets the reference for future day-over-day comparisons.`);
  }

  // Overall — PMR (KPI) and DSP spend side by side, plus a take-rate / margin read.
  L.push('Overall');
  const kpiD = overall?.pmrDeltaPct != null ? ` (${signed(overall.pmrDeltaPct)} vs prev)` : '';
  const spD = overall?.spendDeltaPct != null ? ` (${signed(overall.spendDeltaPct)} vs prev)` : '';
  const take = m.inAppSpend > 0 ? fmtPct(m.inAppPmr / m.inAppSpend) : 'n/a';
  const margin = (overall?.pmrDeltaPct != null && overall?.spendDeltaPct != null)
    ? (overall.pmrDeltaPct - overall.spendDeltaPct > 0.01 ? ' — margin improving (PMR outpacing spend)'
      : overall.spendDeltaPct - overall.pmrDeltaPct > 0.01 ? ' — margin compressing (spend outpacing PMR)' : '')
    : '';
  L.push(`• PMR ${fmtCurrency(m.inAppPmr)}${kpiD}; DSP spend ${fmtCurrency(m.inAppSpend)}${spD}; take rate ~${take}${margin}.`);
  if (m.inAppPmr <= 0) L.push('• PMR is $0 in this export — check the PMR column is mapped so PMR metrics populate.');

  // By Region — PMR + DSP spend
  if (reg.length) {
    L.push('By Region');
    const regLine = (r: AggRow) => `• ${r.region}: PMR ${fmtCurrency(r.pmr)} (${pmrShare(r.pmr)})${dimSign(dod?.region, String(r.region ?? ''))}, DSP spend ${fmtCurrency(r.spend)}${dimSpendSign(dod?.region, String(r.region ?? ''))}.`;
    L.push(regLine(reg[0]));
    if (reg[1]) L.push(regLine(reg[1]));
  }

  // By POD (avoid repeating GCK when it is already the top POD) — PMR + DSP spend
  const pods = byPod(rows, 5);
  if (pods.length) {
    L.push('By POD');
    const topIsGck = isGckPod(String(pods[0].pod ?? ''));
    const podLine = (label: string, r: AggRow, gck = false) =>
      `• ${label}: PMR ${fmtCurrency(r.pmr)} (${pmrShare(r.pmr)})${dimSign(dod?.pod, gck ? 'GCK' : String(r.pod ?? ''))}, DSP spend ${fmtCurrency(r.spend)}${dimSpendSign(dod?.pod, gck ? 'GCK' : String(r.pod ?? ''))}.`;
    L.push(podLine(`Top POD ${pods[0].pod}`, pods[0]));
    if (topIsGck && pods[1]) {
      L.push(podLine(`Next ${pods[1].pod}`, pods[1]));
    } else if (!topIsGck) {
      const gckRow = pods.find((p) => isGckPod(String(p.pod ?? '')));
      if (gckRow) L.push(podLine('GCK POD', gckRow, true));
    }
  }

  // By Publisher (overall market)
  L.push('By Publisher');
  if (tp.length) L.push(`• Top publisher ${tp[0].publisher}: PMR ${fmtCurrency(tp[0].pmr)} (${pmrShare(tp[0].pmr)})${pubSign(dod?.publishers, String(tp[0].publisher ?? ''))}.`);
  const topShare = tp.length && m.inAppPmr > 0 ? tp.slice(0, 3).reduce((s, p) => s + p.pmr, 0) / m.inAppPmr : 0;
  if (topShare) L.push(`• Top 3 publishers = ${fmtPct(topShare)} of PMR — ${topShare > 0.5 ? 'concentrated, worth monitoring' : 'reasonably diversified'}.`);

  // GCK POD — the deep dive (our POD's publishers & bundles)
  L.push('GCK POD');
  const gckPubUp = gainers(dod?.gckPublishers?.rows, (r) => r.publisher);
  const gckPubDown = decliners(dod?.gckPublishers?.rows, (r) => r.publisher);
  if (gckPubUp || gckPubDown) {
    L.push(`• Publishers (PMR)${gckPubUp ? ` — growing: ${gckPubUp}` : ''}${gckPubDown ? `${gckPubUp ? ';' : ' —'} watch: ${gckPubDown}` : ''}.`);
  }
  const gckBunUp = gainers(dod?.gckBundles?.rows, (r) => r.name);
  const gckBunDown = decliners(dod?.gckBundles?.rows, (r) => r.name);
  if (gckBunUp || gckBunDown) {
    L.push(`• Bundles (PMR)${gckBunUp ? ` — growing: ${gckBunUp}` : ''}${gckBunDown ? `${gckBunUp ? ';' : ' —'} watch: ${gckBunDown}` : ''}.`);
  }
  if (!gckPubUp && !gckPubDown && !gckBunUp && !gckBunDown) {
    L.push('• No prior day yet for GCK — baseline set; publisher/bundle movements will show here from the next run.');
  }

  return L.join('\n');
}

/** Top 2 PMR gainers / decliners from a DoD rows list. `name` extracts the label. */
type DeltaLike = { pmrDeltaPct: number | null; status: string };
function gainers<T extends DeltaLike>(rows: T[] | undefined, name: (r: T) => string): string {
  return (rows ?? [])
    .filter((r) => r.pmrDeltaPct != null && r.status === 'up')
    .sort((a, b) => b.pmrDeltaPct! - a.pmrDeltaPct!).slice(0, 2)
    .map((r) => `${name(r)} ${signed(r.pmrDeltaPct)}`).join(', ');
}
function decliners<T extends DeltaLike>(rows: T[] | undefined, name: (r: T) => string): string {
  return (rows ?? [])
    .filter((r) => r.pmrDeltaPct != null && r.status === 'down')
    .sort((a, b) => a.pmrDeltaPct! - b.pmrDeltaPct!).slice(0, 2)
    .map((r) => `${name(r)} ${signed(r.pmrDeltaPct)}`).join(', ');
}

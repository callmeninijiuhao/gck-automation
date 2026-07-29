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

/** Parse Looker-style numbers: "$32.06 K" → 32060, "$0.9158" → 0.9158, "(1,234)" → -1234. */
const toNum = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()$,\s]/g, '');
  const m = s.match(/^-?\d*\.?\d+/);
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
  for (const rec of raw) {
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

// ── Ad format → size pivot (in-app) ──
export interface AdSizeRow { adSize: string; spend: number; ecpm: number; shareOfFormat: number; }
export interface AdFormatGroup { adFormat: string; spend: number; ecpm: number; share: number; sizes: AdSizeRow[]; }

export function adFormatPivot(rows: BundleRow[]): AdFormatGroup[] {
  const ia = inApp(rows);
  const total = sumSpend(ia);
  return aggregate(ia, ['adFormat']).map((f) => {
    const fmt = String(f.adFormat ?? '') || '(none)';
    const sizes = aggregate(ia.filter((r) => (r.adFormat ?? '') === (f.adFormat ?? '')), ['adSize'])
      .map((s) => ({
        adSize: String(s.adSize ?? '') || '(none)', spend: s.spend, ecpm: s.ecpm,
        shareOfFormat: f.spend > 0 ? s.spend / f.spend : 0,
      }));
    return { adFormat: fmt, spend: f.spend, ecpm: f.ecpm, share: total > 0 ? f.spend / total : 0, sizes };
  });
}

// ── Top bundles broken down by their top publishers (formats merged into a list) ──
export interface BundlePubRow { publisher: string; formats: string[]; spend: number; ecpm: number; shareOfBundle: number; }
export interface BundleGroup {
  bundle: string; appName: string; platform: string; spend: number; ecpm: number; share: number;
  rows: BundlePubRow[];
}

export function bundlePublisherBreakdown(rows: BundleRow[], n = 20, topPub = 3): BundleGroup[] {
  const ia = inApp(rows);
  const total = sumSpend(ia);
  return aggregate(ia, ['bundle', 'appName', 'platform']).slice(0, n).map((b) => {
    const sub = ia.filter((r) => (r.bundle ?? '') === (b.bundle ?? ''));
    const rws = aggregate(sub, ['publisher']).slice(0, topPub).map((p) => {
      const formats = [...new Set(sub.filter((r) => (r.publisher ?? '') === (p.publisher ?? '')).map((r) => r.adFormat).filter(Boolean))] as string[];
      return {
        publisher: String(p.publisher ?? '') || '(unknown)',
        formats, spend: p.spend, ecpm: p.ecpm,
        shareOfBundle: b.spend > 0 ? p.spend / b.spend : 0,
      };
    });
    return {
      bundle: String(b.bundle ?? ''), appName: String(b.appName ?? ''), platform: String(b.platform ?? ''),
      spend: b.spend, ecpm: b.ecpm, share: total > 0 ? b.spend / total : 0, rows: rws,
    };
  });
}

// ── extra in-app dimension breakdowns (Android + iOS focus) ──
export const byDsp = (rows: BundleRow[], n = 20) =>
  aggregate(inApp(rows), ['dsp']).slice(0, n);

export const byAdFormatSize = (rows: BundleRow[], n = 30) =>
  aggregate(inApp(rows), ['adFormat', 'adSize']).slice(0, n);

export const byCountry = (rows: BundleRow[], n = 30) =>
  aggregate(inApp(rows), ['country']).slice(0, n);

export const byRegion = (rows: BundleRow[]) =>
  aggregate(inApp(rows), ['region']);

export const byPod = (rows: BundleRow[], n = 30) =>
  aggregate(inApp(rows), ['pod', 'region']).slice(0, n);

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
  totalRevenue: number;    // publisher revenue (all rows)
  distinctBundles: number;
  distinctDomains: number;
  ctvEcpm: number;
  topBundleName: string;
  topBundleSpend: number;
}

const sumSpend = (rows: BundleRow[]) => rows.reduce((s, r) => s + r.spend, 0);

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
    totalPmr: rows.reduce((s, r) => s + r.pmr, 0),
    totalRevenue: rows.reduce((s, r) => s + r.revenue, 0),
    distinctBundles: new Set(inApp(rows).map((r) => r.bundle)).size,
    distinctDomains: new Set(webMweb(rows).map((r) => r.domain)).size,
    ctvEcpm: ctvImps > 0 ? (ctvSpend / ctvImps) * 1000 : 0,
    topBundleName: tb ? String(tb.appName ?? tb.bundle) : 'N/A',
    topBundleSpend: tb ? tb.spend : 0,
  };
}

/**
 * Deterministic structured summary (no LLM).
 *
 * ▶▶ LLM NARRATIVE SLOT ◀◀
 * To add an AI narrative later, generate the text from these same aggregated
 * tables (topBundles / topDomains / ctvSummary / computeMetrics) and pass it in
 * place of this string. Do NOT feed raw rows to the model — only summaries.
 */
export function generateStructuredSummary(rows: BundleRow[], dateLabel: string): string {
  const m = computeMetrics(rows);
  const share = (v: number) => fmtPct(m.inAppSpend > 0 ? v / m.inAppSpend : 0);
  const reg = byRegion(rows);
  const pod = byPod(rows, 5);
  const tb = topBundles(rows, 5);
  const tp = topPublishers(rows, 5);
  const fmt = adFormatPivot(rows);
  const L: string[] = [];
  L.push(`High-level summary for ${dateLabel} (mobile in-app).`);
  L.push(`In-app DSP spend ${fmtCurrency(m.inAppSpend)}; PubMatic revenue (PMR) ${fmtCurrency(m.totalPmr)}; publisher revenue ${fmtCurrency(m.totalRevenue)}.`);
  if (reg.length) L.push(`By region: ${reg.map((r) => `${r.region} ${fmtCurrency(r.spend)} (${share(r.spend)}, eCPM ${fmtEcpm(r.ecpm)})`).join('; ')}.`);
  if (pod.length) L.push(`Top PODs: ${pod.map((p) => `${p.pod} ${fmtCurrency(p.spend)} (${share(p.spend)})`).join('; ')}.`);
  if (tb.length) L.push(`Top bundles: ${tb.map((b) => `${b.appName} ${fmtCurrency(b.spend)} (${share(b.spend)}, eCPM ${fmtEcpm(b.ecpm)})`).join('; ')}.`);
  if (tp.length) L.push(`Top publishers: ${tp.map((p) => `${p.publisher} ${fmtCurrency(p.spend)} (${share(p.spend)})`).join('; ')}.`);
  if (fmt.length) L.push(`Ad formats: ${fmt.map((f) => `${f.adFormat} ${fmtCurrency(f.spend)} (${fmtPct(f.share)})`).join('; ')}.`);
  L.push(`${m.distinctBundles} distinct in-app bundles.`);
  return L.join('\n');
}

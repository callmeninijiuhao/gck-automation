// ─────────────────────────────────────────────
// Top Bundle & Domain Analysis — types & config
// Fetches per-DSP analytics exports (apps.pubmatic.com/api/analytics/export/dsp/<id>)
// and aggregates bundle (mobile in-app) / web+mweb / CTV performance.
// ─────────────────────────────────────────────

export type Environment = 'in_app' | 'mweb' | 'web' | 'ctv' | 'other';

/** One standardized export row (after RENAME_MAP + numeric coercion + enrichment). */
export interface BundleRow {
  dspId?: string;
  domain?: string;
  publisherId?: string;
  publisher?: string;
  platform: string;
  adFormat?: string;
  adSize?: string;
  country?: string;
  dsp?: string;
  region?: string;
  pod?: string;
  date?: string;
  application?: string;
  bundle?: string;
  /** DSP Spend (buyer spend) — the primary ranking metric */
  spend: number;
  /** PMR = PubMatic Revenue (our revenue) */
  pmr: number;
  /** Revenue = Publisher revenue (our customer's revenue) */
  revenue: number;
  paidImpressions: number;
  /** as-reported eCPM; NEVER aggregated — recomputed from summed totals */
  ecpm: number;
  nonZeroBidResponses: number;
  totalBidRequests: number;
  // ── derived ──
  environment: Environment;
  /** readable app/site name: Application → Bundle → Domain */
  appName: string;
}

/** An aggregated group. eCPM / bidRate are recomputed from summed totals. */
export interface AggRow {
  bundle?: string;
  appName?: string;
  platform?: string;
  adFormat?: string;
  adSize?: string;
  country?: string;
  dsp?: string;
  region?: string;
  pod?: string;
  publisher?: string;
  domain?: string;
  spend: number;
  pmr: number;
  revenue: number;
  paidImpressions: number;
  nonZeroBidResponses: number;
  totalBidRequests: number;
  ecpm: number;
  bidRate: number;
}

/** Partner-shareable row — bundle + country + eCPM (no spend / DSP data). */
export interface PartnerRow {
  bundle: string;
  appName: string;
  platform: string;
  country: string;
  ecpm: number;
}

export interface DspFetchError {
  dspId: string;
  error: string;
}

export interface RunProgress {
  current: number;
  total: number;
  dspId: string;
}

export const TOP_BUNDLE_CONFIG = {
  /** latest complete day = today − dataLatencyDays (on the 28th → the 26th) */
  dataLatencyDays: 2,
  topBundles: 50,
  topDomains: 50,
  /** hard Excel per-sheet row cap; raw beyond this is split across sheets */
  excelMaxRows: 1_048_576,
} as const;

/** Exported XLS/CSV header labels → internal BundleRow fields. */
export const RENAME_MAP: Record<string, keyof BundleRow> = {
  'Domain': 'domain',
  'Publisher ID': 'publisherId',
  'Publisher': 'publisher',
  'Platform': 'platform',
  'Ad Format': 'adFormat',
  'Application': 'application',
  'Bundle': 'bundle',
  'Spend($)': 'spend',
  'Paid Impressions': 'paidImpressions',
  'eCPM($)': 'ecpm',
  'Non-zero bid responses': 'nonZeroBidResponses',
  'Total bids requests for DSP': 'totalBidRequests',
};

/** Human-readable Platform values → internal environment buckets. */
export const PLATFORM_BUCKETS: Record<Exclude<Environment, 'other'>, string[]> = {
  in_app: ['Mobile App Android', 'Mobile App iOS'],
  mweb: ['Mobile Web'],
  web: ['Web'],
  ctv: ['CTV'],
};

export const ENV_LABEL: Record<Environment, string> = {
  in_app: 'Mobile In-App',
  mweb: 'Mobile Web',
  web: 'Web',
  ctv: 'CTV',
  other: 'Other',
};

export const NA_TOKENS = new Set(['', 'na', 'n/a', 'null', 'none', 'unknown', 'undefined']);

export const NUMERIC_FIELDS: (keyof BundleRow)[] = [
  'spend', 'paidImpressions', 'ecpm', 'nonZeroBidResponses', 'totalBidRequests',
];

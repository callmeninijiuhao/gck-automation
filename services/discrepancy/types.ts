// ─────────────────────────────────────────────
// Discrepancy Check-in — types & config
// Ported from gck-discrepancy-checkin/daily_report.py
// ─────────────────────────────────────────────

export interface DiscrepancyTokens {
  pubtoken: string;
  bearerToken: string;
  cookie?: string;
}

export interface DiscrepancyRow {
  reportDate?: string;
  publisherId: string;
  publisherName?: string;
  integration?: string;
  region?: string;
  dspId?: string;
  dsp: string;
  pubmaticSpend: number | null;
  pubmaticSpendPst?: number | null;
  pubmaticImps: number | null;
  dspSpend: number | null;
  dspImps: number | null;
  spendDiscrepancyAbs?: number | null;
  /** 小数：0.05 = 5% */
  spendDiscrepancyPct: number | null;
  mtdSpendDiscrepancyPct?: number | null;
  netMarginPct?: number | null;
  impsDiscrepancyAbs?: number | null;
  /** 小数：0.05 = 5% */
  discrepancyRate: number | null;
  publisherRevenue?: number | null;
  needsAttention: boolean;
}

export interface DspSummaryRow {
  dsp: string;
  publishers: number;
  rows: number;
  pubmaticSpend: number;
  dspSpend: number;
  pubmaticImps: number;
  dspImps: number;
  spendDiscrepancyPct: number | null;
  discrepancyRate: number | null;
}

export interface PublisherFetchError {
  publisherId: string;
  error: string;
}

export interface RunProgress {
  current: number;
  total: number;
  publisherId: string;
}

export const DISCREPANCY_CONFIG = {
  apiBase: 'https://apps.pubmatic.com/api/admin-custom-report/export',
  reportName: 'DSP Discrepancy Report',
  resourceType: 'Publisher',
  reportId: 'PUBLISHERREP_56',
  reportType: '1',
  /** 数据延迟：API 通常只能拉到 T-3 */
  dataLatencyDays: 3,
  /** 单个 publisher 请求超时（ms）：防止某个请求挂死拖住整个 run */
  fetchTimeoutMs: 90000,
  /** 告警/高亮阈值（0.05 = 5%） */
  alertThreshold: 0.05,
  highlightThreshold: 0.05,
  topSpendersCount: 20,
} as const;

/** 真实 CSV 列名 → 内部字段 */
export const RENAME_MAP: Record<string, keyof DiscrepancyRow> = {
  'Report Date': 'reportDate',
  'Publisher ID': 'publisherId',
  'Publisher': 'publisherName',
  'Integration': 'integration',
  'Region': 'region',
  'Demand Partner ID': 'dspId',
  'Demand Partner Name': 'dsp',
  'PubMatic Spend($)': 'pubmaticSpend',
  'PubMatic Spend PST($)': 'pubmaticSpendPst',
  'PubMatic Impressions': 'pubmaticImps',
  'Demand Partner Spend($)': 'dspSpend',
  'Demand Partner Impressions': 'dspImps',
  'Spend Discrepancy(PM-DemandPartner)($)': 'spendDiscrepancyAbs',
  'Spend Discrepancy Percentage': 'spendDiscrepancyPct',
  'MTD Spend Discrepancy (%)': 'mtdSpendDiscrepancyPct',
  'Net Margin After Discrepancy (%)': 'netMarginPct',
  'Impressions Discrepancy': 'impsDiscrepancyAbs',
  'Impressions Discrepancy Percentage': 'discrepancyRate',
  'Publisher Revenue($)': 'publisherRevenue',
};

export const NUMERIC_FIELDS: (keyof DiscrepancyRow)[] = [
  'pubmaticSpend', 'pubmaticSpendPst', 'pubmaticImps', 'dspSpend', 'dspImps',
  'spendDiscrepancyAbs', 'spendDiscrepancyPct', 'mtdSpendDiscrepancyPct',
  'netMarginPct', 'impsDiscrepancyAbs', 'discrepancyRate', 'publisherRevenue',
];

/** 原始值是"百分比数字"（-30.44 表示 -30.44%）的字段，需 /100 */
export const PERCENTAGE_FIELDS: (keyof DiscrepancyRow)[] = [
  'spendDiscrepancyPct', 'mtdSpendDiscrepancyPct', 'netMarginPct', 'discrepancyRate',
];

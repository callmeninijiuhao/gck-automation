// ─────────────────────────────────────────────
// Read an uploaded Looker export (CSV / Excel) and auto-map its columns to the
// canonical BundleRow fields. Column names vary by Looker view, so the page
// also lets the user correct the mapping before analysis.
// ─────────────────────────────────────────────
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export type CanonicalField =
  | 'spend' | 'pmr' | 'revenue' | 'paidImpressions' | 'ecpm'
  | 'bundle' | 'platform' | 'adFormat' | 'adSize' | 'country' | 'dsp'
  | 'region' | 'pod' | 'date'
  | 'publisher' | 'publisherId' | 'application';

export const CANONICAL_FIELDS: CanonicalField[] = [
  'platform', 'bundle', 'application', 'dsp', 'adFormat', 'adSize', 'country',
  'region', 'pod', 'date', 'publisher', 'publisherId',
  'spend', 'pmr', 'revenue', 'paidImpressions', 'ecpm',
];

export const FIELD_LABELS: Record<CanonicalField, string> = {
  platform: 'Platform / Environment',
  bundle: 'Bundle (app bundle / Domain column)',
  application: 'Application (app name)',
  dsp: 'DSP',
  adFormat: 'Ad Format',
  adSize: 'Ad Size',
  country: 'Country',
  region: 'Region (APAC / EMEA / Americas)',
  pod: 'POD',
  date: 'Date (optional — used as report date)',
  publisher: 'Publisher',
  publisherId: 'Publisher ID',
  spend: 'DSP Spend',
  pmr: 'PMR (PubMatic revenue)',
  revenue: 'Revenue (publisher revenue)',
  paidImpressions: 'Paid Impressions (optional — derived from eCPM if absent)',
  ecpm: 'eCPM',
};

export const REQUIRED_FIELDS: CanonicalField[] = ['platform', 'spend', 'bundle'];

const ALIASES: Record<CanonicalField, string[]> = {
  spend: ['dsp spend', 'demand partner spend', 'spend', 'cost', 'media spend', 'gross spend', 'net spend'],
  pmr: ['pmr', 'pubmatic revenue', 'pm revenue'],
  revenue: ['revenue', 'publisher revenue', 'pub revenue'],
  paidImpressions: ['paid impressions', 'impressions', 'paid imps', 'imps', 'impression'],
  ecpm: ['ecpm', 'effective cpm'],
  bundle: ['bundle', 'bundle id', 'app bundle', 'bundleid', 'store bundle', 'domain'],
  platform: ['platform', 'environment', 'inventory type', 'device type', 'media type'],
  adFormat: ['ad format', 'format', 'creative type', 'ad type'],
  adSize: ['ad size', 'size', 'creative size', 'ad dimensions'],
  country: ['country', 'geo', 'country name'],
  dsp: ['dsp', 'demand partner', 'demand partner name', 'buyer', 'dsp name'],
  region: ['publisher region', 'region', 'geo region'],
  pod: ['pod', 'publisher pod', 'team'],
  date: ['date', 'report date', 'day'],
  publisher: ['publisher', 'publisher name', 'pub name'],
  publisherId: ['publisher id', 'pub id', 'pubid', 'publisher identifier'],
  application: ['application', 'app', 'app name', 'application name'],
};

/** normalize a header for matching: lowercase, drop parentheticals like "($)", collapse spaces */
const norm = (s: string): string =>
  String(s ?? '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface ParsedFile { headers: string[]; rows: Record<string, unknown>[]; }

/** Parse raw CSV/TSV text (used by both file upload and Slack auto-fetch). */
export function parseCsvText(text: string): ParsedFile {
  const parsed = Papa.parse<Record<string, unknown>>(text.trim(), { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? (parsed.data[0] ? Object.keys(parsed.data[0]) : []);
  return { headers, rows: parsed.data };
}

export async function parseFile(file: File): Promise<ParsedFile> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    const headerRow = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] as string[] | undefined;
    const headers = rows.length ? Object.keys(rows[0]) : (headerRow ?? []);
    return { headers, rows };
  }
  return parseCsvText(await file.text());
}

/** Best-effort header → field mapping. Unmatched fields come back undefined. */
export function autoMap(headers: string[]): Record<CanonicalField, string | undefined> {
  const normed = headers.map((h) => ({ raw: h, n: norm(h) }));
  const out = {} as Record<CanonicalField, string | undefined>;
  for (const field of CANONICAL_FIELDS) {
    const aliases = ALIASES[field].map(norm);
    // exact normalized match first, then a contains-match as a fallback
    const exact = normed.find((h) => aliases.includes(h.n));
    const partial = exact ?? normed.find((h) => aliases.some((a) => h.n === a || h.n.includes(a)));
    out[field] = partial?.raw;
  }
  return out;
}

// ─────────────────────────────────────────────
// LLM narrative for the Top Bundle tool via the PubMatic Brain API.
// The generic Brain transport/config now lives in services/llm/brainClient;
// this file owns only the narrative-specific prompt building.
//
// The model receives ONLY the compact aggregated summaries — never raw rows.
// ─────────────────────────────────────────────
import { chatComplete, LlmConfig, ChatMessage } from '@/services/llm/brainClient';
import { AggRow } from './types';
import { AnalysisMetrics, AdFormatGroup, BundleGroup, fmtCurrency, fmtEcpm, fmtPct } from './dataProcessor';
import { ReportSummaries } from './reportBuilder';
import { DayOverDay } from './history';

// Re-export the shared Brain client surface so existing importers of this
// module (e.g. LlmConfig, DEFAULT_LLM_CONFIG, BRAIN_MODELS) keep working.
export {
  chatComplete, BRAIN_BASE_URL, BRAIN_MODELS, DEFAULT_LLM_CONFIG,
} from '@/services/llm/brainClient';
export type { BrainEnv, LlmConfig, ChatMessage } from '@/services/llm/brainClient';

// ── prompt building (summaries only, compact) ──
const aggTable = (rows: AggRow[], cols: [keyof AggRow | 'ecpmF' | 'bidF', string][], max = 25): string => {
  const header = cols.map(([, l]) => l).join(' | ');
  const body = rows.slice(0, max).map((r) => cols.map(([k]) => {
    if (k === 'ecpmF') return fmtEcpm(r.ecpm);
    if (k === 'bidF') return fmtPct(r.bidRate);
    if (k === 'spend' || k === 'pmr' || k === 'revenue') return fmtCurrency(r[k]);
    return String((r as any)[k] ?? '');
  }).join(' | ')).join('\n');
  return `${header}\n${body}`;
};

function dayOverDayText(dod: DayOverDay | null): string {
  if (!dod) return 'Day-over-day: no prior day on record (baseline run).';
  const names = (arr: { appName: string; bundle: string }[]) => arr.length ? arr.map((b) => `${b.appName} (${b.bundle})`).join('; ') : 'none';
  const movers = dod.movers.length ? dod.movers.map((m) => `${m.appName} #${m.from}->#${m.to}`).join('; ') : 'none';
  return [
    `Day-over-day vs ${dod.prevDate} (top ${dod.topN} in-app bundles):`,
    `New entrants: ${names(dod.newEntrants)}`,
    `Dropped out: ${names(dod.dropped)}`,
    `Biggest rank moves: ${movers}`,
  ].join('\n');
}

function pivotText(groups: AdFormatGroup[]): string {
  return groups.map((g) => {
    const head = `${g.adFormat}: ${fmtCurrency(g.spend)} (${fmtPct(g.share)} of total, eCPM ${fmtEcpm(g.ecpm)})`;
    const sizes = g.sizes.map((s) => `   - ${s.adSize}: ${fmtCurrency(s.spend)} (${fmtPct(s.shareOfFormat)} of format, eCPM ${fmtEcpm(s.ecpm)})`).join('\n');
    return sizes ? `${head}\n${sizes}` : head;
  }).join('\n');
}

function bundlePubText(groups: BundleGroup[]): string {
  return groups.map((g) => {
    const head = `${g.appName} (${g.bundle}): ${fmtCurrency(g.spend)} (${fmtPct(g.share)} of in-app, eCPM ${fmtEcpm(g.ecpm)})`;
    const rows = g.rows.map((r) => `   - ${r.publisher} [${r.formats.join('/')}]: ${fmtCurrency(r.spend)} (${fmtPct(r.shareOfBundle)} of bundle, eCPM ${fmtEcpm(r.ecpm)})`).join('\n');
    return rows ? `${head}\n${rows}` : head;
  }).join('\n');
}

export function buildNarrativePrompt(
  summaries: ReportSummaries, metrics: AnalysisMetrics, dateLabel: string, dayOverDay: DayOverDay | null = null,
): ChatMessage[] {
  const system = 'You are a senior programmatic revenue analyst delivering an EXECUTIVE BRIEFING to your team (GCK, a mobile in-app POD within APAC), '
    + 'the way an agency or DSP briefs an advertiser. You are given pre-aggregated summary tables. '
    + 'CRITICAL: do NOT just restate or list the tables. INTERPRET them — explain what stands out and WHY it matters, what is healthy vs. '
    + 'concerning, what is driving the movement, and what we should do about it. Write with a confident, analytical point of view, as if you '
    + 'read the data and formed a judgement. '
    + 'Think about: overall revenue quality (DSP spend vs PMR — our take rate — and publisher revenue); where spend and RISK are concentrated '
    + '(a few publishers/bundles/regions carrying the business = dependency risk); eCPM outliers (very high, or very low with high volume = '
    + 'monetization problem or opportunity); ad format / size efficiency; geo concentration; and day-over-day shifts (what grew, what dropped, why it matters). '
    + 'Publishers are our CUSTOMERS — name who drives results and flag dependency. '
    + 'Structure your output as: '
    + '(1) EXECUTIVE SUMMARY — 4-6 sentences telling the story of the day, not a numbers dump; '
    + '(2) KEY FINDINGS — 4-8 bullets, each a specific interpretation backed by one supporting number; '
    + '(3) RECOMMENDATIONS — specific, actionable optimizations for GCK (e.g. scale X, investigate low eCPM on Y, reduce dependency on publisher Z, '
    + 'test a format/size/geo that works elsewhere). '
    + 'Lead with insight; cite numbers only to support a point. Do NOT invent numbers not present in the tables. '
    + 'Plain professional prose, no emoji, no decorative symbols.';

  const user = [
    `Date: ${dateLabel}`,
    `Totals — DSP spend ${fmtCurrency(metrics.totalSpend)}, PMR (PubMatic revenue) ${fmtCurrency(metrics.totalPmr)}, `
      + `publisher revenue ${fmtCurrency(metrics.totalRevenue)}. In-app ${fmtCurrency(metrics.inAppSpend)} (${fmtPct(metrics.inAppShare)}), `
      + `web/mweb ${fmtCurrency(metrics.webSpend)}, CTV ${fmtCurrency(metrics.ctvSpend)}.`,
    'Note: Spend = DSP (buyer) spend; PMR = PubMatic revenue; Revenue = publisher revenue. Comment on take rate (PMR vs DSP spend) where relevant.',
    '',
    dayOverDayText(dayOverDay),
    '',
    '## 1. In-app by region (DSP spend, PMR, eCPM)',
    aggTable(summaries.byRegion, [['region', 'Region'], ['spend', 'DSPSpend'], ['pmr', 'PMR'], ['ecpmF', 'eCPM']]),
    '',
    '## 2. In-app by POD',
    aggTable(summaries.byPod, [['pod', 'POD'], ['region', 'Region'], ['spend', 'DSPSpend'], ['pmr', 'PMR'], ['ecpmF', 'eCPM']]),
    '',
    '## 3. Top in-app bundles',
    aggTable(summaries.topBundles, [['appName', 'App'], ['publisher', 'Publisher'], ['platform', 'Platform'], ['spend', 'DSPSpend'], ['ecpmF', 'eCPM']]),
    '',
    '## 4. In-app by country',
    aggTable(summaries.byCountry, [['country', 'Country'], ['spend', 'DSPSpend'], ['ecpmF', 'eCPM']]),
    '',
    '## 5-6. In-app by ad format then size (pivot; % of format for sizes)',
    pivotText(summaries.adFormatPivot),
    '',
    '## In-app by DSP',
    aggTable(summaries.byDsp, [['dsp', 'DSP'], ['spend', 'DSPSpend'], ['ecpmF', 'eCPM']]),
    '',
    '## Top publishers (our customers) — DSP spend, PMR, publisher revenue',
    aggTable(summaries.topPublishers, [['publisher', 'Publisher'], ['spend', 'DSPSpend'], ['pmr', 'PMR'], ['revenue', 'PubRev'], ['ecpmF', 'eCPM']]),
    '',
    '## Top bundles broken down by publisher & format',
    bundlePubText(summaries.bundlePublisher),
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Generate the narrative text. Throws on failure (caller falls back to the deterministic summary). */
export async function generateNarrative(
  summaries: ReportSummaries, metrics: AnalysisMetrics, dateLabel: string, cfg: LlmConfig, dayOverDay: DayOverDay | null = null,
): Promise<string> {
  return chatComplete(buildNarrativePrompt(summaries, metrics, dateLabel, dayOverDay), cfg);
}

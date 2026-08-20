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
import { DoDContext, DimDayOverDay } from './history';

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

// Whole % once |Δ| rounds to ≥1%; smaller-but-nonzero moves keep up to 2 decimals so the
// model is handed the real value (e.g. "-0.02%") instead of a flattened "0%".
const signedPct = (frac: number | null): string => {
  if (frac === null) return 'n/a';
  const pct = frac * 100;
  const r = Math.round(pct);
  if (r !== 0) return `${r > 0 ? '+' : ''}${r}%`;
  if (Math.abs(pct) < 0.005) return '0%';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
};

/** Compact day-over-day digest for the model — PMR is the KPI, so movers are ranked
    by PMR change (spend shown alongside). Covers region / POD / DSP / publisher /
    GCK POD / ad format / bundle, so the model can attribute change accurately. */
function dayOverDayText(dod: DoDContext | null): string {
  if (!dod || (!dod.overall && !dod.bundle && !dod.publishers)) {
    return 'Day-over-day: no prior day on record (baseline run) — do not fabricate any change figures.';
  }
  const lines: string[] = ['Day-over-day context (PMR = our KPI; use ONLY these figures to attribute change; do not invent):'];
  if (dod.overall) {
    lines.push(`Overall in-app PMR ${signedPct(dod.overall.pmrDeltaPct)} vs ${dod.overall.prevDate}`
      + `; DSP spend ${signedPct(dod.overall.spendDeltaPct)}.`);
  }
  // Each mover carries BOTH PMR and DSP-spend deltas so the model can analyse spend and divergences.
  const bothDelta = (r: { pmrDeltaPct: number | null; spendDeltaPct: number | null }) =>
    `PMR ${signedPct(r.pmrDeltaPct)} / spend ${signedPct(r.spendDeltaPct)}`;
  const dim = (label: string, d: DimDayOverDay | null) => {
    const movers = (d?.rows ?? [])
      .filter((r) => r.pmrDeltaPct !== null && r.status !== 'flat')
      .slice(0, 6).map((r) => `${r.name} ${bothDelta(r)}`);
    if (movers.length) lines.push(`${label}: ${movers.join('; ')}.`);
  };
  dim('By region', dod.region);
  dim('By POD', dod.pod);
  dim('By DSP', dod.dsp);
  dim('By ad format', dod.adFormat);
  if (dod.publishers?.rows.length) {
    const movers = dod.publishers.rows
      .filter((r) => r.pmrDeltaPct !== null && r.status !== 'flat')
      .slice(0, 8).map((r) => `${r.publisher} ${bothDelta(r)}`);
    const news = dod.publishers.rows.filter((r) => r.status === 'new').slice(0, 6).map((r) => r.publisher);
    if (movers.length) lines.push(`Publisher movers (overall): ${movers.join('; ')}.`);
    if (news.length) lines.push(`New in top publishers: ${news.join('; ')}.`);
  }
  if (dod.gckPublishers?.rows.length) {
    const movers = dod.gckPublishers.rows
      .filter((r) => r.pmrDeltaPct !== null && r.status !== 'flat')
      .slice(0, 8).map((r) => `${r.publisher} ${bothDelta(r)}`);
    if (movers.length) lines.push(`GCK POD publisher movers: ${movers.join('; ')}.`);
  }
  if (dod.gckBundles?.rows.length) {
    const movers = dod.gckBundles.rows
      .filter((r) => r.pmrDeltaPct !== null && r.status !== 'flat')
      .slice(0, 8).map((r) => `${r.name} PMR ${signedPct(r.pmrDeltaPct)}`);
    if (movers.length) lines.push(`GCK POD bundle movers: ${movers.join('; ')}.`);
  }
  if (dod.bundle) {
    const names = (arr: { appName: string; bundle: string }[]) => arr.length ? arr.map((b) => `${b.appName} (${b.bundle})`).join('; ') : 'none';
    lines.push(`Top bundles — new entrants: ${names(dod.bundle.newEntrants)}; dropped out: ${names(dod.bundle.dropped)}.`);
  }
  return lines.join('\n');
}

function pivotText(groups: AdFormatGroup[]): string {
  return groups.map((g) => {
    const head = `${g.adFormat}: PMR ${fmtCurrency(g.pmr)} (${fmtPct(g.pmrShare)} of total PMR), DSP spend ${fmtCurrency(g.spend)}, eCPM ${fmtEcpm(g.ecpm)}`;
    const sizes = g.sizes.map((s) => `   - ${s.adSize}: PMR ${fmtCurrency(s.pmr)} (${fmtPct(s.pmrShareOfFormat)} of format), spend ${fmtCurrency(s.spend)}, eCPM ${fmtEcpm(s.ecpm)}`).join('\n');
    return sizes ? `${head}\n${sizes}` : head;
  }).join('\n');
}

function bundlePubText(groups: BundleGroup[]): string {
  return groups.map((g) => {
    const head = `${g.appName} (${g.bundle}): PMR ${fmtCurrency(g.pmr)} (${fmtPct(g.pmrShare)} of in-app PMR), DSP spend ${fmtCurrency(g.spend)}, eCPM ${fmtEcpm(g.ecpm)}`;
    const rows = g.rows.map((r) => `   - ${r.publisher} [${r.formats.join('/')}]: PMR ${fmtCurrency(r.pmr)} (${fmtPct(r.pmrShareOfBundle)} of bundle), spend ${fmtCurrency(r.spend)}, eCPM ${fmtEcpm(r.ecpm)}`).join('\n');
    return rows ? `${head}\n${rows}` : head;
  }).join('\n');
}

export function buildNarrativePrompt(
  summaries: ReportSummaries, metrics: AnalysisMetrics, dateLabel: string, dayOverDay: DoDContext | null = null,
): ChatMessage[] {
  const system = 'You are a senior programmatic revenue analyst writing a concise DAILY BRIEF about the GCK POD, a mobile in-app POD within APAC. '
    + 'This email is read by senior leadership AND may be forwarded to other teams, so write for a mixed audience: macro first, then drill down. '
    + 'You are given pre-aggregated summary tables plus a day-over-day (DoD) context block. Interpret, do not restate. Keep it tight — readable in under a minute. '
    + '\n\nOUTPUT FORMAT — for clean visual structure, group the points under short TOPIC CATEGORIES, top-down (big picture first):\n'
    + 'Line 1: the heading "Executive Summary".\n'
    + 'Line 2: ONE short intro sentence setting the tone from the overall PMR DoD move and naming the core contributor(s) '
    + '(e.g. "Today is a good day — overall in-app PMR grew +18% vs 2026-08-10, led mainly by EMEA and the GCK POD."). A light, human line is welcome.\n'
    + 'Then these categories, each on its own line as a short label, followed by 1-3 concise "• " sub-bullets:\n'
    + '"Overall" — PMR total + vs-prev, DSP spend + vs-prev, take rate.\n'
    + '"By Region" — the leading region(s) and their moves.\n'
    + '"By POD" — the leading POD(s) and their moves, including how GCK POD ranks.\n'
    + '"By Publisher" — the top publisher(s) across the whole market and any concentration/dependency risk.\n'
    + '"GCK POD" — a focused read on GCK only: which GCK publishers grew and which declined (name them with signed %), and which GCK bundles grew or dropped. This is the most important section — be specific.\n'
    + 'Keep each sub-bullet to ONE short idea — do NOT cram many entities separated by ";" into one bullet (that tires the reader). '
    + 'Do NOT write meta lines like "Bottom line" or "for leadership". Do NOT label anything "our POD"/"our own" — just say "GCK POD". '
    + 'Do NOT state that the data is in-app / 100% in-app or mention web / mweb / CTV — every dataset here is mobile in-app, so it is assumed.\n\n'
    + 'METRICS RULE: analyse TWO metrics every day — PMR (PubMatic revenue, the KPI) AND DSP spend (buyer spend, watched daily too). '
    + 'Lead each data point with PMR, but always pair it with the DSP spend figure and ITS change — do not report PMR alone. '
    + 'Actively call out where the two DIVERGE: if DSP spend rises but PMR lags (take rate compressing) or PMR rises faster than spend (margin improving), say so explicitly — that is a key monetization signal. '
    + 'Also surface notable DSP-spend movers in their own right (a buyer/region/publisher whose spend jumped or dropped), even if PMR moved less. '
    + 'For EVERY data point that has a prior day, give the vs-previous direction with a signed percentage (e.g. "+12%", "-8%") for BOTH PMR and spend where relevant, so increase vs decrease is obvious at a glance. '
    + 'NEVER write a bare percentage: every % MUST be immediately labelled with the metric it refers to — write "PMR +32%" or "spend -16%", never a lone "+32%". A reader must never have to guess whether a number is PMR or spend. When you list several movers (e.g. GCK publishers or bundles), put the metric label once at the start of that list — e.g. "growing (PMR): X +32%, Y +26%" — so each figure is unambiguously PMR. '
    + '\n\nSTYLE: clear, direct business/data language — phenomenon + cause + business impact so a non-technical reader gets it instantly. '
    + 'Accurate over fancy: common business verbs (grow, decline, driven by, primary cause); avoid jargon, buzzwords, ornate phrasing. '
    + 'For anything down, use neutral, constructive wording (e.g. "experienced an adjustment", "shows temporary fluctuation", "normalising") — never harsh words like "collapsed", "plummeted", "bad", "failed". '
    + 'GROUNDING: use ONLY numbers present in the tables and the DoD context; do NOT invent figures. If there is no prior day, say the baseline is set and omit change claims. '
    + 'Name the publishers driving results. Output only the "Executive Summary" heading, the intro line, the category labels, and "• " sub-bullets; keep signed percentages like "+12%"/"-8%" intact (a renderer colours them); no emoji, no other markdown, no tables.';

  const user = [
    `Date: ${dateLabel} (mobile in-app dataset).`,
    `Totals — PMR (PubMatic revenue) ${fmtCurrency(metrics.inAppPmr)}, DSP spend ${fmtCurrency(metrics.inAppSpend)}, `
      + `publisher revenue ${fmtCurrency(metrics.totalRevenue)}.`,
    'Note: PMR = PubMatic revenue (lead with this); Spend = DSP (buyer) spend; Revenue = publisher revenue. Comment on take rate (PMR vs DSP spend) where relevant. Do not mention environment split — the data is all mobile in-app.',
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
  summaries: ReportSummaries, metrics: AnalysisMetrics, dateLabel: string, cfg: LlmConfig, dayOverDay: DoDContext | null = null,
): Promise<string> {
  return chatComplete(buildNarrativePrompt(summaries, metrics, dateLabel, dayOverDay), cfg);
}

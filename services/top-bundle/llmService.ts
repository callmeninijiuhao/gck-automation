// ─────────────────────────────────────────────
// LLM narrative via the PubMatic Brain API (OpenAI-compatible chat).
//
// Two environments (see internal guidance):
//   - Non-prod (stage): https://stagellm.pubmatic.com   — dev/CICD, keys …-dev-stage / …-cicd-stage
//   - Production:        https://llm.pubmatic.com        — prod keys only
// You can only call non-prod → non-prod.
//
// Key handling mirrors the repo's secret pattern:
//   - Dev/browser: POST to the local server /api/llm; the Bearer key lives in server/.env.
//   - Desktop (Tauri): call the Brain API directly via native_fetch; the key is entered
//     in the tool's LLM settings and stored only on this computer (never in the git bundle).
//
// The model receives ONLY the compact aggregated summaries — never raw rows.
// ─────────────────────────────────────────────
import { PROXY_BASE } from '@/services/discrepancy/apiService';
import { isTauri, nativeFetch } from '@/services/discrepancy/nativeBridge';
import { AggRow } from './types';
import { AnalysisMetrics, AdFormatGroup, BundleGroup, fmtCurrency, fmtEcpm, fmtPct } from './dataProcessor';
import { ReportSummaries } from './reportBuilder';
import { DayOverDay } from './history';

export type BrainEnv = 'stage' | 'prod';

export interface LlmConfig {
  environment: BrainEnv;
  /** e.g. "(paid) gpt-4o-mini", "anthropic.claude-3-7-sonnet-20250219-v1:0", "llama3.1:70b" */
  model: string;
  /** required for desktop (Tauri) direct calls; dev/browser uses server/.env */
  apiKey: string;
  temperature?: number;
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export const BRAIN_BASE_URL: Record<BrainEnv, string> = {
  stage: 'https://stagellm.pubmatic.com',
  prod: 'https://llm.pubmatic.com',
};

// Verified available on the Brain stage instance (names include the "(paid) " prefix).
export const BRAIN_MODELS = [
  '(paid) claude-sonnet-5',
  '(paid) claude-opus-4-8',
  '(paid) claude-opus-4-6-thinking',
  '(paid) claude-opus-4-6',
  '(paid) claude-sonnet-4-6-thinking',
  '(paid) claude-sonnet-4-6',
  '(paid) claude-sonnet-4.5',
  '(paid) claude-3-7-sonnet',
  '(paid) claude-3-5-sonnet',
  '(paid) claude-haiku-4.5',
  '(paid) claude-3-5-haiku',
  '(paid) gpt-4o',
  '(paid) gpt-4o-mini',
];

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  environment: 'stage',
  model: '(paid) claude-sonnet-5',
  apiKey: '',
  temperature: 0.3,
};

const endpointFor = (env: BrainEnv) => `${BRAIN_BASE_URL[env]}/v1/chat/completions`;

/** Pull the assistant text out of an OpenAI-compatible response. Handles Claude/Bedrock
    responses where message.content is an array of {type,text} blocks. */
function extractContent(text: string): string {
  let data: any;
  try { data = JSON.parse(text); } catch { return ''; }
  let c = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  if (Array.isArray(c)) c = c.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
  return typeof c === 'string' ? c : '';
}

/** Low-level chat completion. Throws on transport / HTTP / API errors and on empty output. */
export async function chatComplete(messages: ChatMessage[], cfg: LlmConfig): Promise<string> {
  // NB: no `temperature` (newer Brain Claude models reject it). max_tokens must be
  // GENEROUS: sonnet-5 is a reasoning model whose internal "thinking" consumes the
  // token budget — too small (e.g. 2000) leaves nothing for visible content and the
  // response comes back empty. 8000 leaves room for reasoning + a full briefing.
  const payload = { model: cfg.model, messages, max_tokens: 8000 };

  let raw: string;
  if (isTauri()) {
    if (!cfg.apiKey) throw new Error('LLM API key not set — add it in the tool\'s LLM settings.');
    const res = await nativeFetch(endpointFor(cfg.environment), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    raw = res.text;
  } else {
    // Dev/browser: key is added server-side from server/.env.
    const resp = await fetch(`${PROXY_BASE}/api/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    raw = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 300)}`);
    // The server returns the raw upstream JSON, or { ok:false, error } on failure.
    try {
      const j = JSON.parse(raw);
      if (j && j.ok === false) throw new Error(j.error || 'LLM request failed');
    } catch (e) {
      if (e instanceof Error && e.message !== 'LLM request failed' && !/^Unexpected|JSON/.test(e.message)) throw e;
    }
  }

  const content = extractContent(raw);
  if (!content.trim()) throw new Error(`LLM returned empty content. Raw response: ${raw.slice(0, 1500)}`);
  return content;
}

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

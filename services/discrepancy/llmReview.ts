// ─────────────────────────────────────────────
// AI Data Review (advisory) for the Discrepancy Check-in tool.
//
// IMPORTANT — division of responsibility:
//   • Numeric correctness (aggregation sums, percentage math, dedup, corrupted-row
//     drops) is handled DETERMINISTICALLY in dataProcessor.ts. The LLM is NEVER asked
//     to recompute or verify arithmetic — it would be a downgrade (LLMs are unreliable
//     at math) and a hallucination risk.
//   • This module runs AFTER the deterministic layer. It computes plausibility/anomaly
//     candidates in code, then asks the Brain LLM to triage them like a human analyst:
//     rate overall data health, flag what's worth a human look, and suggest follow-ups.
//     The output is ADVISORY, not authoritative.
//
// The model receives ONLY compact aggregates + flagged candidates — never the full raw table.
// ─────────────────────────────────────────────
import { DiscrepancyRow, DspSummaryRow } from './types';
import { fmtNum, fmtPct } from './dataProcessor';
import { chatComplete, LlmConfig, ChatMessage } from '@/services/llm/brainClient';

export type AnomalyReason =
  | 'one-sided-spend'      // one side reports ~0 while the other has real spend
  | 'spend-without-imps'   // meaningful spend but ~0 impressions on both sides
  | 'severe-discrepancy';  // |spend discrepancy| far beyond the highlight threshold

export interface AnomalyCandidate {
  publisherId: string;
  publisherName?: string;
  dsp: string;
  reasons: AnomalyReason[];
  pubmaticSpend: number | null;
  dspSpend: number | null;
  pubmaticImps: number | null;
  dspImps: number | null;
  spendDiscrepancyPct: number | null;
  /** larger of the two spends — used to rank by materiality */
  materiality: number;
}

const num = (v: number | null | undefined): number => (v ?? 0);

/** Deterministic anomaly detection — data-quality red flags fixed thresholds can miss. */
export function detectAnomalies(rows: DiscrepancyRow[]): AnomalyCandidate[] {
  const out: AnomalyCandidate[] = [];
  for (const r of rows) {
    const pm = num(r.pubmaticSpend);
    const ds = num(r.dspSpend);
    const pmImps = num(r.pubmaticImps);
    const dsImps = num(r.dspImps);
    const reasons: AnomalyReason[] = [];

    // One side reports ~0 spend while the other has meaningful spend (reporting/mapping gap).
    if ((pm >= 1 && ds < 1) || (ds >= 1 && pm < 1)) reasons.push('one-sided-spend');
    // Real spend but effectively no impressions on either side (broken feed / mismatched metric).
    if (Math.max(pm, ds) >= 1 && pmImps <= 0 && dsImps <= 0) reasons.push('spend-without-imps');
    // Discrepancy an order of magnitude past the ±5% highlight — worth explaining, not just flagging.
    if (r.spendDiscrepancyPct !== null && Math.abs(r.spendDiscrepancyPct) > 0.5) reasons.push('severe-discrepancy');

    if (reasons.length) {
      out.push({
        publisherId: r.publisherId, publisherName: r.publisherName, dsp: r.dsp, reasons,
        pubmaticSpend: r.pubmaticSpend, dspSpend: r.dspSpend,
        pubmaticImps: r.pubmaticImps, dspImps: r.dspImps,
        spendDiscrepancyPct: r.spendDiscrepancyPct,
        materiality: Math.max(pm, ds),
      });
    }
  }
  // Most material first, so the compact prompt keeps the ones that matter.
  return out.sort((a, b) => b.materiality - a.materiality);
}

const REASON_LABEL: Record<AnomalyReason, string> = {
  'one-sided-spend': 'one side reports ~0 spend',
  'spend-without-imps': 'spend present but ~0 impressions',
  'severe-discrepancy': 'discrepancy far beyond ±5%',
};

const MAX_CANDIDATES = 30;
const MAX_DSP_ROWS = 25;

function totalsLine(rows: DiscrepancyRow[]): string {
  const pm = rows.reduce((s, r) => s + num(r.pubmaticSpend), 0);
  const ds = rows.reduce((s, r) => s + num(r.dspSpend), 0);
  const pmImps = rows.reduce((s, r) => s + num(r.pubmaticImps), 0);
  const dsImps = rows.reduce((s, r) => s + num(r.dspImps), 0);
  const disc = pm !== 0 ? (pm - ds) / pm : null;
  return `Totals across ${rows.length} rows — PubMatic Spend $${fmtNum(pm)}, DSP Spend $${fmtNum(ds)} `
    + `(overall Spend Discrepancy ${fmtPct(disc)}); PubMatic Imps ${fmtNum(pmImps)}, DSP Imps ${fmtNum(dsImps)}.`;
}

function dspTable(summary: DspSummaryRow[]): string {
  const header = 'DSP | Pubs | Rows | PM Spend | DSP Spend | Spend Disc | Imps Disc';
  const body = summary.slice(0, MAX_DSP_ROWS).map((r) =>
    `${r.dsp} | ${r.publishers} | ${r.rows} | $${fmtNum(r.pubmaticSpend)} | $${fmtNum(r.dspSpend)} | `
    + `${fmtPct(r.spendDiscrepancyPct)} | ${fmtPct(r.discrepancyRate)}`).join('\n');
  return `${header}\n${body}`;
}

function candidateTable(cands: AnomalyCandidate[]): string {
  if (!cands.length) return 'None — no data-quality red flags detected by the deterministic checks.';
  const header = 'Publisher | DSP | Flags | PM Spend | DSP Spend | PM Imps | DSP Imps | Spend Disc';
  const body = cands.slice(0, MAX_CANDIDATES).map((c) => {
    const name = c.publisherName ? `${c.publisherId} (${c.publisherName})` : c.publisherId;
    const flags = c.reasons.map((r) => REASON_LABEL[r]).join('; ');
    return `${name} | ${c.dsp} | ${flags} | $${fmtNum(c.pubmaticSpend)} | $${fmtNum(c.dspSpend)} | `
      + `${fmtNum(c.pubmaticImps)} | ${fmtNum(c.dspImps)} | ${fmtPct(c.spendDiscrepancyPct)}`;
  }).join('\n');
  const more = cands.length > MAX_CANDIDATES ? `\n(+${cands.length - MAX_CANDIDATES} more not shown)` : '';
  return `${header}\n${body}${more}`;
}

function highlightTable(rows: DiscrepancyRow[]): string {
  if (!rows.length) return 'None exceed the threshold.';
  const header = 'Publisher | DSP | PM Spend | DSP Spend | Spend Disc | Imps Disc';
  const body = rows.slice(0, MAX_CANDIDATES).map((r) => {
    const name = r.publisherName ? `${r.publisherId} (${r.publisherName})` : r.publisherId;
    return `${name} | ${r.dsp} | $${fmtNum(r.pubmaticSpend)} | $${fmtNum(r.dspSpend)} | `
      + `${fmtPct(r.spendDiscrepancyPct)} | ${fmtPct(r.discrepancyRate)}`;
  }).join('\n');
  const more = rows.length > MAX_CANDIDATES ? `\n(+${rows.length - MAX_CANDIDATES} more not shown)` : '';
  return `${header}\n${body}${more}`;
}

function fetchErrorLine(errors: { publisherId: string; error: string }[]): string {
  if (!errors.length) return 'All requested publishers returned data.';
  const sample = errors.slice(0, 15).map((e) => e.publisherId).join(', ');
  const more = errors.length > 15 ? ` …(+${errors.length - 15} more)` : '';
  return `${errors.length} publisher(s) returned NO data this run (excluded from totals): ${sample}${more}. `
    + 'A DSP that normally contributes could be under-reported purely because its publisher(s) failed to fetch.';
}

export function buildReviewPrompt(params: {
  rows: DiscrepancyRow[];
  dspSummary: DspSummaryRow[];
  highlights: DiscrepancyRow[];
  candidates: AnomalyCandidate[];
  fetchErrors: { publisherId: string; error: string }[];
  reportDate: string;
}): ChatMessage[] {
  const { rows, dspSummary, highlights, candidates, fetchErrors, reportDate } = params;

  const system =
    'You are a senior programmatic QA analyst reviewing a daily DSP Discrepancy report for the GCK team '
    + '(a mobile in-app POD). Discrepancy = (PubMatic reported spend/impressions) vs (the DSP partner\'s reported numbers). '
    + 'CRITICAL: every number below was pre-computed by a deterministic, already-validated pipeline and is CORRECT. '
    + 'Do NOT recompute, re-sum, or recalculate anything, and do NOT introduce any number that is not shown to you. '
    + 'Your job is a PLAUSIBILITY / DATA-QUALITY review — like an experienced analyst eyeballing the report for things '
    + 'worth a human\'s attention that the fixed ±5% threshold might miss. '
    + 'Weigh common benign explanations before alarming: reporting lag, timezone cutoffs (PubMatic PST vs DSP UTC), '
    + 'rounding on tiny volumes, and partial-day data. A one-sided ~0 usually means a reporting/mapping gap, not lost money. '
    + 'Output EXACTLY these three sections, plain professional prose, no emoji, no decorative symbols:\n'
    + '1. DATA HEALTH: exactly one of [Looks healthy | Minor concerns | Needs review], then one sentence of justification.\n'
    + '2. ANOMALIES TO CHECK: a short bullet list; each bullet names the entity, states what is odd citing ONE supporting '
    + 'number from the data, and gives the single most likely cause. If nothing is genuinely notable, say so plainly.\n'
    + '3. SUGGESTED FOLLOW-UPS: a few concrete, actionable bullets (what/who to verify). '
    + 'Be concise and do not manufacture concerns when the data looks fine.';

  const user = [
    `Report date: ${reportDate}`,
    totalsLine(rows),
    fetchErrorLine(fetchErrors),
    '',
    '## DSP-level summary (team-wide, aggregated across publishers)',
    dspTable(dspSummary),
    '',
    `## Combos already flagged over the ±5% threshold (${highlights.length})`,
    highlightTable(highlights),
    '',
    '## Data-quality red flags detected deterministically (for your triage)',
    candidateTable(candidates),
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export interface DataReviewResult { text: string; candidates: AnomalyCandidate[]; }

/** Run the advisory AI review. Throws on LLM failure (caller shows a friendly message). */
export async function generateDataReview(params: {
  rows: DiscrepancyRow[];
  dspSummary: DspSummaryRow[];
  highlights: DiscrepancyRow[];
  fetchErrors: { publisherId: string; error: string }[];
  reportDate: string;
  cfg: LlmConfig;
}): Promise<DataReviewResult> {
  const candidates = detectAnomalies(params.rows);
  const messages = buildReviewPrompt({ ...params, candidates });
  const text = await chatComplete(messages, params.cfg);
  return { text: text.trim(), candidates };
}

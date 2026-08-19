// ─────────────────────────────────────────────
// Internal Daily Brief email (HTML) + CSV builders. No emoji. Calibri 12pt body.
// Order (leadership-facing): Executive Summary → By Region → By POD →
// By DSP (top 10 + top 5 bundles each) → Publisher DoD (overall Top 20) →
// GCK POD Top 20 Publishers → Top Bundles (top 20, merged w/ publishers) →
// By Country (top 10 + DoD) → By Ad Format & Size (Display top 5).
// ─────────────────────────────────────────────
import { AggRow, PartnerRow } from './types';
import {
  AnalysisMetrics, AdFormatGroup, BundleGroup, DspGroup, fmtCurrency, fmtEcpm, fmtPct,
} from './dataProcessor';
import {
  BundleChange, PublisherDayOverDay, DimDayOverDay, dimChangeOf, OverallDoD,
} from './history';

export interface ReportSummaries {
  topBundles: AggRow[];
  topPublishers: AggRow[];      // overall Top 20 publishers (baseline for the DoD table)
  gckPublishers: AggRow[];      // GCK POD Top 20 publishers
  byDsp: AggRow[];
  dspGroups: DspGroup[];        // Top 10 DSP, each with its Top 5 bundles
  byCountry: AggRow[];          // Top 10 countries
  byRegion: AggRow[];
  byPod: AggRow[];
  adFormatPivot: AdFormatGroup[];
  bundlePublisher: BundleGroup[]; // Top 20 bundles merged with publisher breakdown
}

/** Day-over-day inputs threaded through the email. PMR is the KPI, so every
    "vs prev" arrow is based on PMR change. */
export interface EmailDoD {
  overall: OverallDoD | null;
  publishers: PublisherDayOverDay | null;     // overall Top 20
  gckPublishers: PublisherDayOverDay | null;  // GCK POD Top 20
  region: DimDayOverDay | null;
  pod: DimDayOverDay | null;
  dsp: DimDayOverDay | null;
  country: DimDayOverDay | null;
  adFormat: DimDayOverDay | null;
  bundleChangeMap: Record<string, BundleChange>;
}

const EMPTY_DOD: EmailDoD = {
  overall: null, publishers: null, gckPublishers: null,
  region: null, pod: null, dsp: null, country: null, adFormat: null, bundleChangeMap: {},
};

export function buildEmailSubject(dateLabel: string): string {
  return `DoD Performance Change Analysis — ${dateLabel}`;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface ColSpec { label: string; align?: 'right'; }

const TABLE_FONT = "font-family:Calibri,'Segoe UI',Arial,sans-serif";

/** Render a table. Cells are pre-formatted HTML strings. */
function htmlTable(cols: ColSpec[], rows: string[][]): string {
  if (!rows.length) return '<p><i>No data.</i></p>';
  const head = cols.map((c) => `<th style="text-align:${c.align || 'left'}">${c.label}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${cols[i].align || 'left'}">${c}</td>`).join('')}</tr>`).join('');
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:11pt;${TABLE_FONT}">`
    + `<thead style="background:#1976d2;color:white"><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Share of a total (used for both DSP-spend % and PMR %). */
const shareOf = (v: number, base: number) => fmtPct(base > 0 ? v / base : 0);

/** Colour signed deltas ("+12%" green / "-8%" red, bold) inside already-escaped text. */
const DELTA_RE = /([+−\-]\d+(?:\.\d+)?%)/g;
const colorizeDeltas = (escaped: string): string =>
  escaped.replace(DELTA_RE, (m) => {
    const up = m.trim().startsWith('+');
    return `<span style="color:${up ? '#188038' : '#d93025'};font-weight:bold">${m}</span>`;
  });

/** Escape + colour signed deltas (no label auto-bolding). */
const renderInline = (s: string): string => colorizeDeltas(esc(s));

/** Render the Insights narrative as spaced paragraphs / bulleted lists / section
    subheadings — mirrors the in-app InsightsBody so email and page match. */
function insightsHtml(text: string): string {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const sectionTitles = /^(executive summary|key points?|key findings?|key takeaways?|key changes?|game changers?|change contributors?|recommendations?|summary|findings?|overview|next steps)\s*:?$/i;
  const isHeading = (l: string) => sectionTitles.test(l) || (/^[A-Z0-9][A-Z0-9 ,&/()\-]{2,39}:?$/.test(l) && !/[a-z]/.test(l));
  const bullet = (l: string) => l.match(/^(?:[•\-*]|\d+\.)\s+(.*)$/);
  // A short standalone Title-Case label (no digits/punctuation) is a topic category.
  const isCategory = (l: string) => l.length <= 40 && /^[A-Za-z][A-Za-z &/()'-]*$/.test(l);
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  lines.forEach((line, i) => {
    const b = bullet(line);
    const core = b ? b[1] : line;   // a heading may arrive wrapped as a bullet ("• Executive Summary")
    if (isHeading(core)) {
      closeList();
      html += `<p style="margin:${i === 0 ? '0' : '14px'} 0 6px;font-size:11pt;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#1976d2">${esc(core.replace(/:$/, ''))}</p>`;
      return;
    }
    if (b) {
      if (!inList) { html += '<ul style="margin:6px 0;padding-left:20px">'; inList = true; }
      html += `<li style="margin:4px 0;line-height:1.6">${renderInline(b[1])}</li>`;
      return;
    }
    if (!b && isCategory(core)) {   // topic category sub-heading (dark bold, not the big blue heading)
      closeList();
      html += `<p style="margin:10px 0 3px;font-size:11.5pt;font-weight:700;color:#0b3d66">${esc(core.replace(/:$/, ''))}</p>`;
      return;
    }
    closeList();
    html += `<p style="margin:6px 0;line-height:1.6">${renderInline(line)}</p>`;
  });
  closeList();
  return `<div style="background:#f5f7fa;padding:14px 18px;border-left:4px solid #1976d2;border-radius:0 6px 6px 0;font-size:12pt;color:#333">${html}</div>`;
}

/** Coloured PMR up/down/new arrow for a day-over-day change (email cell).
    Generic over any {status, pmrDeltaPct} — publisher / country / dimension. */
function changeArrowHtml(c: { status: 'new' | 'up' | 'down' | 'flat'; pmrDeltaPct: number | null } | undefined): string {
  if (!c) return '&mdash;';
  if (c.status === 'new') return '<span style="color:#1976d2;font-weight:bold">NEW</span>';
  if (c.pmrDeltaPct === null) return '&mdash;';
  const pct = Math.abs(Math.round(c.pmrDeltaPct * 100));
  if (c.status === 'up') return `<span style="color:#188038;font-weight:bold">&uarr; ${pct}%</span>`;
  if (c.status === 'down') return `<span style="color:#d93025;font-weight:bold">&darr; ${pct}%</span>`;
  return '<span style="color:#777">flat</span>';
}

/** vs-prev PMR cell for a group row, looked up by name in a dimension DoD. */
const dimCell = (dod: DimDayOverDay | null, name: string): string => changeArrowHtml(dimChangeOf(dod, name));

const dodLegend = '(PMR vs prev: <span style="color:#188038">&uarr;</span> up / <span style="color:#d93025">&darr;</span> down / NEW)';

/** Top-N publisher table: DSP Spend + DSP % + PMR + PMR % + PMR vs prev. Baseline-safe. */
function publisherDodTable(ranked: AggRow[], dod: PublisherDayOverDay | null, totalSpend: number, totalPmr: number): string {
  const cell = (name: string, spend: number, pmr: number, vs: string) =>
    [esc(name) || '(unknown)', fmtCurrency(spend), shareOf(spend, totalSpend), fmtCurrency(pmr), shareOf(pmr, totalPmr), vs];
  const rows: string[][] = dod
    ? dod.rows.map((r) => cell(r.publisher, r.spend, r.pmr, changeArrowHtml(r)))
    : ranked.map((r) => cell(String(r.publisher ?? ''), r.spend, r.pmr, '&mdash;'));
  return htmlTable(
    [{ label: 'Publisher' }, { label: 'DSP Spend', align: 'right' }, { label: 'DSP %', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'PMR %', align: 'right' }, { label: 'vs prev', align: 'right' }],
    rows,
  );
}

/** Top-N country table (baseline-safe like publisherDodTable). */
function countryDodTable(ranked: AggRow[], dod: DimDayOverDay | null, totalSpend: number, totalPmr: number): string {
  const cell = (name: string, spend: number, pmr: number, vs: string) =>
    [esc(name) || '(unknown)', fmtCurrency(spend), shareOf(spend, totalSpend), fmtCurrency(pmr), shareOf(pmr, totalPmr), vs];
  const rows: string[][] = dod
    ? dod.rows.map((r) => cell(r.name, r.spend, r.pmr, changeArrowHtml(r)))
    : ranked.map((r) => cell(String(r.country ?? ''), r.spend, r.pmr, '&mdash;'));
  return htmlTable(
    [{ label: 'Country' }, { label: 'DSP Spend', align: 'right' }, { label: 'DSP %', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'PMR %', align: 'right' }, { label: 'vs prev', align: 'right' }],
    rows,
  );
}

/** By DSP: Top 10 DSP (bold group rows = share of total; PMR vs prev) then their Top 5 bundles (share within the DSP). */
function dspGroupsHtml(groups: DspGroup[], dod: DimDayOverDay | null): string {
  if (!groups.length) return '<p><i>No data.</i></p>';
  const rows: string[][] = [];
  for (const g of groups) {
    rows.push([`<b>${esc(g.dsp)}</b>`, `<b>${fmtCurrency(g.spend)}</b>`, `<b>${fmtPct(g.spendShare)}</b>`, `<b>${fmtCurrency(g.pmr)}</b>`, `<b>${fmtPct(g.pmrShare)}</b>`, `<b>${dimCell(dod, g.dsp)}</b>`, `<b>${fmtEcpm(g.ecpm)}</b>`]);
    for (const b of g.rows) {
      rows.push([`&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#666">${esc(b.appName)}</span> <span style="color:#999">${esc(b.bundle)}</span>`, fmtCurrency(b.spend), fmtPct(b.spendShareOfDsp), fmtCurrency(b.pmr), fmtPct(b.pmrShareOfDsp), '', fmtEcpm(b.ecpm)]);
    }
  }
  return htmlTable(
    [{ label: 'DSP / Bundle' }, { label: 'DSP Spend', align: 'right' }, { label: 'DSP %', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'PMR %', align: 'right' }, { label: 'vs prev', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows,
  );
}

function regionHtml(rows: AggRow[], totalSpend: number, totalPmr: number, dod: DimDayOverDay | null): string {
  return htmlTable(
    [{ label: 'Region' }, { label: 'DSP Spend', align: 'right' }, { label: 'DSP %', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'PMR %', align: 'right' }, { label: 'vs prev', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows.map((r) => [esc(r.region), fmtCurrency(r.spend), shareOf(r.spend, totalSpend), fmtCurrency(r.pmr), shareOf(r.pmr, totalPmr), dimCell(dod, String(r.region ?? '')), fmtEcpm(r.ecpm)]),
  );
}

function podHtml(rows: AggRow[], totalSpend: number, totalPmr: number, dod: DimDayOverDay | null): string {
  return htmlTable(
    [{ label: 'POD' }, { label: 'Region' }, { label: 'DSP Spend', align: 'right' }, { label: 'DSP %', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'PMR %', align: 'right' }, { label: 'vs prev', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows.map((r) => [esc(r.pod), esc(r.region), fmtCurrency(r.spend), shareOf(r.spend, totalSpend), fmtCurrency(r.pmr), shareOf(r.pmr, totalPmr), dimCell(dod, String(r.pod ?? '')), fmtEcpm(r.ecpm)]),
  );
}

/** Ad format → size pivot: format rows (bold, share of total + PMR vs prev) then indented size rows (share of format). */
function pivotHtml(groups: AdFormatGroup[], dod: DimDayOverDay | null): string {
  if (!groups.length) return '<p><i>No data.</i></p>';
  const rows: string[][] = [];
  for (const g of groups) {
    rows.push([`<b>${esc(g.adFormat)}</b>`, `<b>${fmtCurrency(g.spend)}</b>`, `<b>${fmtPct(g.spendShare)}</b>`, `<b>${fmtCurrency(g.pmr)}</b>`, `<b>${fmtPct(g.pmrShare)}</b>`, `<b>${dimCell(dod, g.adFormat)}</b>`, `<b>${fmtEcpm(g.ecpm)}</b>`]);
    for (const s of g.sizes) {
      rows.push([`&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#666">${esc(s.adSize)}</span>`, fmtCurrency(s.spend), fmtPct(s.spendShareOfFormat), fmtCurrency(s.pmr), fmtPct(s.pmrShareOfFormat), '', fmtEcpm(s.ecpm)]);
    }
  }
  return htmlTable(
    [{ label: 'Ad Format / Size' }, { label: 'DSP Spend', align: 'right' }, { label: 'DSP %', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'PMR %', align: 'right' }, { label: 'vs prev', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows,
  );
}

/** Top Bundles (Top 20) merged with their publisher breakdown, plus PMR day-over-day
    on each bundle. Bold group row = the bundle (share of total); indented rows =
    its publishers (share within the bundle). */
function topBundlesMergedHtml(groups: BundleGroup[], changeMap: Record<string, BundleChange>): string {
  if (!groups.length) return '<p><i>No data.</i></p>';
  const rows: string[][] = [];
  for (const g of groups) {
    rows.push([
      `<b>${esc(g.appName)}</b><br><span style="color:#777">${esc(g.bundle)}</span>`,
      '<b>&mdash;</b>',
      `<b>${fmtCurrency(g.spend)}</b>`,
      `<b>${fmtPct(g.spendShare)}</b>`,
      `<b>${fmtCurrency(g.pmr)}</b>`,
      `<b>${fmtPct(g.pmrShare)}</b>`,
      `<b>${fmtEcpm(g.ecpm)}</b>`,
      `<b>${changeArrowHtml(changeMap[String(g.bundle ?? '')])}</b>`,
    ]);
    for (const r of g.rows) {
      rows.push([
        `&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#666">${esc(r.publisher)}</span>`,
        esc(r.formats.join(', ')),
        fmtCurrency(r.spend),
        fmtPct(r.spendShareOfBundle),
        fmtCurrency(r.pmr),
        fmtPct(r.pmrShareOfBundle),
        fmtEcpm(r.ecpm),
        '',
      ]);
    }
  }
  return htmlTable(
    [{ label: 'App / Publisher' }, { label: 'Ad Formats' }, { label: 'DSP Spend', align: 'right' }, { label: 'DSP %', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'PMR %', align: 'right' }, { label: 'eCPM', align: 'right' }, { label: 'vs prev', align: 'right' }],
    rows,
  );
}

/** Highlighted English variance notice (Email Header). One size smaller than body. */
function noticeHtml(): string {
  return '<div style="font-size:10.5pt;background:#fff8e1;border:1px solid #f6c343;color:#7a5b00;'
    + 'padding:8px 12px;border-radius:6px;margin:10px 0">'
    + '<b>Note:</b> Due to automated data pull file size limits, overall data may have a minor variance of ~ -0.5%, '
    + 'primarily originating from tail end rows (bundles &lt; $0.1).'
    + '</div>';
}

/** Signed PMR % for the header overall-DoD line (PMR = our KPI). */
function overallDoDLine(dod: OverallDoD | null): string {
  if (!dod || dod.pmrDeltaPct === null) return '';
  const p = Math.round(dod.pmrDeltaPct * 100);
  const arrow = p >= 1 ? '<span style="color:#188038">&uarr;</span>' : p <= -1 ? '<span style="color:#d93025">&darr;</span>' : '';
  const spend = dod.spendDeltaPct !== null ? ` (spend ${dod.spendDeltaPct >= 0 ? '+' : ''}${Math.round(dod.spendDeltaPct * 100)}%)` : '';
  return ` &nbsp;|&nbsp; <b>PMR DoD:</b> ${arrow} ${p >= 0 ? '+' : ''}${p}% vs ${esc(dod.prevDate)}${spend}`;
}

export function buildEmailHtml(
  summaries: ReportSummaries,
  summaryText: string,
  metrics: AnalysisMetrics,
  dateLabel: string,
  dod: EmailDoD = EMPTY_DOD,
): string {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const s = summaries;
  const ts = metrics.inAppSpend;   // DSP-spend contribution base (in-app spend)
  const tp = metrics.inAppPmr;     // PMR contribution base (in-app PMR)
  return `
    <html><body style="font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:12pt;max-width:1100px;margin:auto;color:#333">
    <h2 style="margin:0 0 6px">DoD Performance Change Analysis — ${dateLabel}</h2>
    ${noticeHtml()}
    <p style="font-size:11pt;color:#555">
      <b>Generated:</b> ${now} UTC<br>
      <b>In-app PMR (PubMatic revenue):</b> ${fmtCurrency(metrics.inAppPmr)} &nbsp;|&nbsp;
      <b>In-app DSP spend:</b> ${fmtCurrency(metrics.inAppSpend)} &nbsp;|&nbsp;
      <b>Publisher revenue:</b> ${fmtCurrency(metrics.totalRevenue)} &nbsp;|&nbsp;
      <b>Bundles:</b> ${metrics.distinctBundles}${overallDoDLine(dod.overall)}
    </p>
    <hr>

    <h3>1. Executive Summary</h3>
    ${insightsHtml(summaryText)}

    <h3>2. By Region</h3>
    ${regionHtml(s.byRegion, ts, tp, dod.region)}

    <h3>3. By POD</h3>
    ${podHtml(s.byPod, ts, tp, dod.pod)}

    <h3>4. By DSP (Top ${s.dspGroups.length}, each with its Top bundles)</h3>
    ${dspGroupsHtml(s.dspGroups, dod.dsp)}
    <p style="font-size:10pt;color:#777;margin:4px 0 0">Group rows = share of total in-app (DSP % of spend, PMR % of PMR) with PMR vs prev; indented bundle rows = share within that DSP.</p>

    <h3>5. Publisher Day-over-Day Changes — Overall Top ${s.topPublishers.length}</h3>
    <p style="font-size:10.5pt;color:#555;margin:4px 0">Whole-market Top ${s.topPublishers.length} publishers, ranked by in-app PMR ${dodLegend}.</p>
    ${publisherDodTable(s.topPublishers, dod.publishers, ts, tp)}

    <h3>6. GCK POD — Top ${s.gckPublishers.length} Publishers</h3>
    <p style="font-size:10.5pt;color:#555;margin:4px 0">GCK POD publishers only, ranked by in-app PMR ${dodLegend}.</p>
    ${publisherDodTable(s.gckPublishers, dod.gckPublishers, ts, tp)}

    <h3>7. Top Bundles (Top ${s.bundlePublisher.length})</h3>
    ${topBundlesMergedHtml(s.bundlePublisher, dod.bundleChangeMap)}
    <p style="font-size:10pt;color:#777;margin:4px 0 0">Group rows = share of total in-app (DSP % / PMR %); indented publisher rows = share within that bundle. "vs prev" = the bundle's PMR day-over-day change.</p>

    <h3>8. By Country (Top ${s.byCountry.length})</h3>
    <p style="font-size:10.5pt;color:#555;margin:4px 0">Top ${s.byCountry.length} countries, ranked by in-app PMR ${dodLegend}.</p>
    ${countryDodTable(s.byCountry, dod.country, ts, tp)}

    <h3>9. By Ad Format &amp; Size</h3>
    ${pivotHtml(s.adFormatPivot, dod.adFormat)}
    <p style="font-size:10pt;color:#777;margin:4px 0 0">Format rows = share of total in-app (DSP % / PMR %) with PMR vs prev; indented size rows = share within that format. Display is limited to its Top 5 sizes.</p>

    <br>
    <p style="color:#999;font-size:10pt">Auto-generated by GCK Automation — DoD Performance Change Analysis</p>
    </body></html>
  `;
}

// ── CSV builders ──
const csvEscape = (v: unknown): string => {
  const str = String(v ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

/** Internal top-bundles CSV (attached to the internal email). */
export function internalBundlesCsv(rows: AggRow[]): string {
  const header = ['Bundle', 'App', 'Platform', 'DSP Spend', 'PMR', 'Publisher Revenue', 'eCPM'];
  const lines = rows.map((r) => [
    r.bundle, r.appName, r.platform, r.spend.toFixed(2), r.pmr.toFixed(2), r.revenue.toFixed(2), r.ecpm.toFixed(4),
  ].map(csvEscape).join(','));
  return [header.join(','), ...lines].join('\n');
}

/** Partner-shareable CSV — bundle + app + platform + country + eCPM (no spend). */
export function partnerCsv(rows: PartnerRow[]): string {
  const header = ['Bundle ID', 'App Name', 'Platform', 'Country', 'eCPM'];
  const lines = rows.map((r) => [r.bundle, r.appName, r.platform, r.country, r.ecpm.toFixed(4)].map(csvEscape).join(','));
  return [header.join(','), ...lines].join('\n');
}

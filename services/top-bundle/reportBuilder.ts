// ─────────────────────────────────────────────
// Internal email report (HTML) + CSV builders. No emoji.
// Top-down: Summary → Top Publishers → Region → POD → Top Bundles → Country →
// DSP → Ad Format (pivot) → Bundle & Publisher → Day-over-day.
// ─────────────────────────────────────────────
import { AggRow, PartnerRow } from './types';
import {
  AnalysisMetrics, AdFormatGroup, BundleGroup, fmtCurrency, fmtEcpm, fmtPct,
} from './dataProcessor';
import { BundleChange, changeLabel, PublisherDayOverDay, PublisherChange } from './history';

export interface ReportSummaries {
  topBundles: AggRow[];
  topPublishers: AggRow[];
  byDsp: AggRow[];
  byCountry: AggRow[];
  byRegion: AggRow[];
  byPod: AggRow[];
  adFormatPivot: AdFormatGroup[];
  bundlePublisher: BundleGroup[];
}

export function buildEmailSubject(dateLabel: string): string {
  return `Bundle Level Analysis — ${dateLabel}`;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface ColSpec { label: string; align?: 'right'; }

/** Render a table. Cells are pre-formatted HTML strings. */
function htmlTable(cols: ColSpec[], rows: string[][]): string {
  if (!rows.length) return '<p><i>No data.</i></p>';
  const head = cols.map((c) => `<th style="text-align:${c.align || 'left'}">${c.label}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${cols[i].align || 'left'}">${c}</td>`).join('')}</tr>`).join('');
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">`
    + `<thead style="background:#1976d2;color:white"><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const contrib = (spend: number, base: number) => fmtPct(base > 0 ? spend / base : 0);

/** Bold a short leading "Label:" prefix for scannability (email). */
const emphLabel = (s: string): string => {
  const m = s.match(/^([A-Za-z][A-Za-z ()/&-]{1,38}?):\s+(.*)$/);
  return m ? `<b>${esc(m[1])}:</b> ${esc(m[2])}` : esc(s);
};

/** Render the Insights narrative as spaced paragraphs / bulleted lists / section
    subheadings — mirrors the in-app InsightsBody so email and page match. */
function insightsHtml(text: string): string {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const sectionTitles = /^(executive summary|key findings?|key takeaways?|recommendations?|summary|findings?|overview|next steps)\s*:?$/i;
  const isHeading = (l: string) => sectionTitles.test(l) || (/^[A-Z0-9][A-Z0-9 ,&/()\-]{2,39}:?$/.test(l) && !/[a-z]/.test(l));
  const bullet = (l: string) => l.match(/^(?:[•\-*]|\d+\.)\s+(.*)$/);
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  lines.forEach((line, i) => {
    const b = bullet(line);
    const core = b ? b[1] : line;   // a heading may arrive wrapped as a bullet ("• Executive Summary")
    if (isHeading(core)) {
      closeList();
      html += `<p style="margin:${i === 0 ? '0' : '14px'} 0 6px;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#1976d2">${esc(core.replace(/:$/, ''))}</p>`;
      return;
    }
    if (b) {
      if (!inList) { html += '<ul style="margin:6px 0;padding-left:20px">'; inList = true; }
      html += `<li style="margin:4px 0;line-height:1.6">${emphLabel(b[1])}</li>`;
      return;
    }
    closeList();
    html += `<p style="margin:6px 0;line-height:1.6">${emphLabel(line)}</p>`;
  });
  closeList();
  return `<div style="background:#f5f7fa;padding:14px 18px;border-left:4px solid #1976d2;border-radius:0 6px 6px 0;font-size:13px;color:#333">${html}</div>`;
}

function publisherHtml(rows: AggRow[], inAppSpend: number): string {
  return htmlTable(
    [{ label: 'Publisher' }, { label: 'DSP Spend', align: 'right' }, { label: 'Contribution', align: 'right' },
      { label: 'PMR', align: 'right' }, { label: 'Publisher Revenue', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows.map((r) => [esc(r.publisher), fmtCurrency(r.spend), contrib(r.spend, inAppSpend), fmtCurrency(r.pmr), fmtCurrency(r.revenue), fmtEcpm(r.ecpm)]),
  );
}

function regionHtml(rows: AggRow[], inAppSpend: number): string {
  return htmlTable(
    [{ label: 'Region' }, { label: 'DSP Spend', align: 'right' }, { label: 'Contribution', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows.map((r) => [esc(r.region), fmtCurrency(r.spend), contrib(r.spend, inAppSpend), fmtCurrency(r.pmr), fmtEcpm(r.ecpm)]),
  );
}

function podHtml(rows: AggRow[], inAppSpend: number): string {
  return htmlTable(
    [{ label: 'POD' }, { label: 'Region' }, { label: 'DSP Spend', align: 'right' }, { label: 'Contribution', align: 'right' }, { label: 'PMR', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows.map((r) => [esc(r.pod), esc(r.region), fmtCurrency(r.spend), contrib(r.spend, inAppSpend), fmtCurrency(r.pmr), fmtEcpm(r.ecpm)]),
  );
}

function bundlesHtml(rows: AggRow[], inAppSpend: number, changeMap: Record<string, BundleChange>): string {
  return htmlTable(
    [{ label: 'Bundle' }, { label: 'App' }, { label: 'Platform' }, { label: 'DSP Spend', align: 'right' }, { label: 'Contribution', align: 'right' }, { label: 'eCPM', align: 'right' }, { label: 'vs prev', align: 'right' }],
    rows.map((r) => [esc(r.bundle), esc(r.appName), esc(r.platform), fmtCurrency(r.spend), contrib(r.spend, inAppSpend), fmtEcpm(r.ecpm), esc(changeLabel(changeMap[String(r.bundle ?? '')]))]),
  );
}

function oneDimHtml(rows: AggRow[], key: keyof AggRow, label: string, inAppSpend: number): string {
  return htmlTable(
    [{ label }, { label: 'DSP Spend', align: 'right' }, { label: 'Contribution', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows.map((r) => [esc(r[key]), fmtCurrency(r.spend), contrib(r.spend, inAppSpend), fmtEcpm(r.ecpm)]),
  );
}

/** Ad format → size pivot: format rows (bold, % of total) then indented size rows (% of format). */
function pivotHtml(groups: AdFormatGroup[]): string {
  if (!groups.length) return '<p><i>No data.</i></p>';
  const rows: string[][] = [];
  for (const g of groups) {
    rows.push([`<b>${esc(g.adFormat)}</b>`, `<b>${fmtCurrency(g.spend)}</b>`, `<b>${fmtPct(g.share)}</b>`, `<b>${fmtEcpm(g.ecpm)}</b>`]);
    for (const s of g.sizes) {
      rows.push([`&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#666">${esc(s.adSize)}</span>`, fmtCurrency(s.spend), fmtPct(s.shareOfFormat), fmtEcpm(s.ecpm)]);
    }
  }
  return htmlTable(
    [{ label: 'Ad Format / Size' }, { label: 'DSP Spend', align: 'right' }, { label: 'Contribution', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows,
  );
}

/** Hierarchical: each bundle is a bold group row, then its publisher × ad-format rows. */
function bundlePublisherHtml(groups: BundleGroup[], inAppSpend: number): string {
  if (!groups.length) return '<p><i>No data.</i></p>';
  const rows: string[][] = [];
  for (const g of groups) {
    rows.push([`<b>${esc(g.appName)}</b><br><span style="color:#777">${esc(g.bundle)}</span>`, '<b>—</b>', '<b>—</b>', `<b>${fmtCurrency(g.spend)}</b>`, `<b>${contrib(g.spend, inAppSpend)}</b>`, `<b>${fmtEcpm(g.ecpm)}</b>`]);
    for (const r of g.rows) {
      rows.push([`&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#666">${esc(r.publisher)}</span>`, esc(r.formats.join(', ')), fmtPct(r.shareOfBundle), fmtCurrency(r.spend), '', fmtEcpm(r.ecpm)]);
    }
  }
  return htmlTable(
    [{ label: 'App / Publisher' }, { label: 'Ad Formats' }, { label: '% of bundle', align: 'right' }, { label: 'DSP Spend', align: 'right' }, { label: 'Contribution', align: 'right' }, { label: 'eCPM', align: 'right' }],
    rows,
  );
}

/** Coloured up/down/new label for a publisher's day-over-day spend change (email cell). */
function pubChangeHtml(c: PublisherChange): string {
  if (c.status === 'new') return '<span style="color:#1976d2;font-weight:bold">NEW</span>';
  if (c.spendDeltaPct === null) return '&mdash;';
  const pct = Math.abs(Math.round(c.spendDeltaPct * 100));
  if (c.status === 'up') return `<span style="color:#188038;font-weight:bold">&uarr; ${pct}%</span>`;
  if (c.status === 'down') return `<span style="color:#d93025;font-weight:bold">&darr; ${pct}%</span>`;
  return '<span style="color:#777">flat</span>';
}

function dayOverDayHtml(dod: PublisherDayOverDay | null, todayDate: string, inAppSpend: number): string {
  if (!dod) return `<p><i>No prior day on record — this run (${esc(todayDate)}) is the baseline for future comparisons.</i></p>`;
  return `<p>Top ${dod.rows.length} publishers by DSP spend vs ${esc(dod.prevDate)} `
    + `(<span style="color:#188038">&uarr;</span> up / <span style="color:#d93025">&darr;</span> down / NEW = not in top publishers previously):</p>`
    + htmlTable(
      [{ label: 'Publisher' }, { label: 'DSP Spend', align: 'right' }, { label: 'Contribution', align: 'right' }, { label: 'vs prev', align: 'right' }],
      dod.rows.map((r) => [esc(r.publisher) || '(unknown)', fmtCurrency(r.spend), contrib(r.spend, inAppSpend), pubChangeHtml(r)]),
    );
}

export function buildEmailHtml(
  summaries: ReportSummaries,
  summaryText: string,
  metrics: AnalysisMetrics,
  dateLabel: string,
  pubDayOverDay: PublisherDayOverDay | null = null,
  changeMap: Record<string, BundleChange> = {},
): string {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const s = summaries;
  const ia = metrics.inAppSpend;
  return `
    <html><body style="font-family:Arial,sans-serif;max-width:1100px;margin:auto;color:#333">
    <h2>Bundle Level Analysis — ${dateLabel}</h2>
    <p>
      <b>Generated:</b> ${now} UTC<br>
      <b>In-app DSP spend:</b> ${fmtCurrency(metrics.inAppSpend)} &nbsp;|&nbsp;
      <b>PMR (PubMatic revenue):</b> ${fmtCurrency(metrics.totalPmr)} &nbsp;|&nbsp;
      <b>Publisher revenue:</b> ${fmtCurrency(metrics.totalRevenue)} &nbsp;|&nbsp;
      <b>Bundles:</b> ${metrics.distinctBundles}
    </p>
    <hr>
    <h3>Insights</h3>
    ${insightsHtml(summaryText)}

    <h3>Top ${s.topPublishers.length} Publishers</h3>
    ${publisherHtml(s.topPublishers, ia)}

    <h3>By Region</h3>
    ${regionHtml(s.byRegion, ia)}

    <h3>By POD</h3>
    ${podHtml(s.byPod, ia)}

    <h3>Top Bundles (top ${s.topBundles.length})</h3>
    ${bundlesHtml(s.topBundles, ia, changeMap)}

    <h3>By Country</h3>
    ${oneDimHtml(s.byCountry, 'country', 'Country', ia)}

    <h3>By DSP</h3>
    ${oneDimHtml(s.byDsp, 'dsp', 'DSP', ia)}

    <h3>By Ad Format &amp; Size</h3>
    ${pivotHtml(s.adFormatPivot)}
    <p style="font-size:11px;color:#777;margin:4px 0 0">Format rows = % of total in-app DSP spend; indented size rows = % within that format.</p>

    <h3>By Bundle &amp; Publisher (top ${s.bundlePublisher.length})</h3>
    ${bundlePublisherHtml(s.bundlePublisher, ia)}
    <p style="font-size:11px;color:#777;margin:4px 0 0">Contribution = the bundle's share of total in-app DSP spend (all bundles, not just the top ${s.bundlePublisher.length}); indented publisher rows show % of that bundle.</p>

    <h3>Publisher day-over-day changes</h3>
    ${dayOverDayHtml(pubDayOverDay, dateLabel, ia)}

    <br>
    <p style="color:#999;font-size:11px">Auto-generated by GCK Automation — Bundle Level Analysis</p>
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

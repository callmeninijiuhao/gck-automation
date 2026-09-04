import React, { useMemo, useRef, useState } from 'react';
import {
  Upload, Send, Eye, EyeOff, X, Plus, RotateCcw, AlertTriangle,
  CheckCircle2, Loader2, ChevronDown, ChevronUp, Terminal, FileSpreadsheet, Share2, BarChart3,
  MessageSquare, RefreshCw, ArrowUp, ArrowDown,
} from 'lucide-react';
import { parseFile, parseCsvText, autoMap, FIELD_LABELS, REQUIRED_FIELDS, CanonicalField, ParsedFile } from '@/services/top-bundle/fileParser';
import { fetchLatestFromSlack, fetchPriorFromSlack, peekLatestFromSlack, peekPriorFromSlack } from '@/services/top-bundle/slackFetch';
import {
  standardizeMapped, topBundles, topPublishers, byDsp, byCountry, byRegion, byPod, byAdFormat,
  adFormatPivot, bundlePublisherBreakdown, partnerList, computeMetrics, generateStructuredSummary, inApp,
  gckPublishers, gckBundles, dspWithBundles, isGckPod,
  fmtCurrency, fmtEcpm, fmtPct,
} from '@/services/top-bundle/dataProcessor';
import {
  saveSnapshot, previousSnapshot, diffTopN, bundleChangeMap, BundleChange,
  savePublisherSnapshot, previousPublisherSnapshot, diffPublishers, PublisherDayOverDay,
  saveDimSnapshot, previousDimSnapshot, diffDim, dimChangeOf, DimDayOverDay,
  saveDailyTotals, previousDailyTotals, dailyTotalsForDate, overallDayOverDay, OverallDoD, DoDContext,
} from '@/services/top-bundle/history';
import {
  buildEmailHtml, buildEmailSubject, partnerCsv, ReportSummaries, EmailDoD,
} from '@/services/top-bundle/reportBuilder';
import { TopBundleExcel } from '@/services/top-bundle/excelGenerator';
import { generateNarrative, LlmConfig, DEFAULT_LLM_CONFIG } from '@/services/top-bundle/llmService';
import { AggRow, BundleRow } from '@/services/top-bundle/types';
import { DEFAULT_EMAIL_RECIPIENTS } from '@/services/top-bundle/defaults';
import { sendEmail } from '@/services/discrepancy/backendService';
import { isTauri, AppSendSettings, DEFAULT_SEND_SETTINGS } from '@/services/discrepancy/nativeBridge';
import { InsightsBody, stripMarkdown } from '@/components/InsightsBody';

const RECIPIENTS_KEY = 'top_bundle_recipients';
const LLM_KEY = 'top_bundle_llm_config';
// Reuse the Discrepancy tool's validated Sending Settings (same SMTP config).
const SEND_SETTINGS_KEY = 'discrepancy_send_settings';

type RunState = 'idle' | 'analyzing' | 'done' | 'error';

interface LogEntry { ts: string; level: 'info' | 'warn' | 'error'; msg: string; }
const LOG_COLORS: Record<LogEntry['level'], string> = { info: '#9ca3af', warn: '#d97706', error: '#dc2626' };

const loadList = (key: string, fallback: string[]): string[] => {
  try {
    const saved = localStorage.getItem(key);
    if (saved) { const p = JSON.parse(saved); if (Array.isArray(p) && p.length) return p; }
  } catch { /* ignore */ }
  return [...fallback];
};

function getLatestDate(latencyDays = 2): string {
  const d = new Date();
  d.setDate(d.getDate() - latencyDays);
  return d.toISOString().slice(0, 10);
}

/** "2026/7/27" or "2026-7-27" -> "2026-07-27"; '' if unrecognized. */
function normalizeDate(s: string): string {
  const m = String(s).trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

/** Persist every per-day snapshot used for day-over-day (bundles, publishers, dims, totals).
    Shared by today's run and the Slack previous-day refresh. `fileId` records which Slack
    file produced this snapshot so a later run can skip re-downloading an unchanged file. */
function saveDaySnapshots(date: string, std: BundleRow[], fileId?: string): void {
  saveSnapshot(date, topBundles(std, 200));
  savePublisherSnapshot(date, topPublishers(std, 100), 'all');
  savePublisherSnapshot(date, gckPublishers(std, 100), 'gck');
  saveDimSnapshot('region', date, byRegion(std), 'region');
  saveDimSnapshot('pod', date, byPod(std, 30), 'pod');
  saveDimSnapshot('dsp', date, byDsp(std, 30), 'dsp');
  saveDimSnapshot('country', date, byCountry(std, 30), 'country');
  saveDimSnapshot('adFormat', date, byAdFormat(std, 30), 'adFormat');
  saveDimSnapshot('gckbundle', date, gckBundles(std, 50), 'appName');
  const m = computeMetrics(std);
  saveDailyTotals(date, { inAppSpend: m.inAppSpend, pmr: m.inAppPmr, revenue: m.totalRevenue, fileId });
}

/** Coloured PMR up/down/new arrow for a day-over-day change (publisher / country / dimension). */
const ChangeIndicator: React.FC<{ c: { status: 'new' | 'up' | 'down' | 'flat'; pmrDeltaPct: number | null } | null | undefined }> = ({ c }) => {
  if (!c) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  if (c.status === 'new') return <span style={{ color: 'var(--primary)', fontWeight: 600 }}>NEW</span>;
  if (c.pmrDeltaPct === null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const pct = Math.abs(Math.round(c.pmrDeltaPct * 100));
  if (c.status === 'up') return <span style={{ color: 'var(--success)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.15rem', justifyContent: 'flex-end' }}><ArrowUp size={14} />{pct}%</span>;
  if (c.status === 'down') return <span style={{ color: 'var(--error)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.15rem', justifyContent: 'flex-end' }}><ArrowDown size={14} />{pct}%</span>;
  return <span style={{ color: 'var(--text-muted)' }}>flat</span>;
};

// ── Day-over-day table (publisher / country): first col + DSP spend + PMR + PMR% + PMR arrow ──
type DeltaCell = { status: 'new' | 'up' | 'down' | 'flat'; pmrDeltaPct: number | null };
type DodRow = { name: string; spend: number; pmr: number; change: DeltaCell | null };

const pubDodRows = (ranked: AggRow[], dod: PublisherDayOverDay | null): DodRow[] =>
  dod ? dod.rows.map((r) => ({ name: r.publisher, spend: r.spend, pmr: r.pmr, change: r }))
      : ranked.map((r) => ({ name: String(r.publisher ?? ''), spend: r.spend, pmr: r.pmr, change: null }));

const dimDodRows = (ranked: AggRow[], dod: DimDayOverDay | null, key: keyof AggRow): DodRow[] =>
  dod ? dod.rows.map((r) => ({ name: r.name, spend: r.spend, pmr: r.pmr, change: r }))
      : ranked.map((r) => ({ name: String(r[key] ?? ''), spend: r.spend, pmr: r.pmr, change: null }));

const DodTable: React.FC<{ firstCol: string; rows: DodRow[]; totalSpend: number; totalPmr: number }> = ({ firstCol, rows, totalSpend, totalPmr }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ background: 'var(--primary)', color: 'white', textAlign: 'left' }}>
          {[firstCol, 'DSP Spend', 'DSP %', 'PMR', 'PMR %', 'vs prev'].map((h, i) => (
            <th key={h} style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap', textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.name || i} style={{ background: i % 2 ? '#f8fafc' : 'white', borderBottom: '1px solid #e5e7eb' }}>
            <td style={{ padding: '0.5rem 0.75rem' }}>{r.name || '(unknown)'}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(r.spend)}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(totalSpend > 0 ? r.spend / totalSpend : 0)}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{fmtCurrency(r.pmr)}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(totalPmr > 0 ? r.pmr / totalPmr : 0)}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}><ChangeIndicator c={r.change} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** Legend / prior-day caption shared by the DoD tables (PMR-based). */
const DodCaption: React.FC<{ prevDate?: string; label: string }> = ({ prevDate, label }) => (
  <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>
    {label}{prevDate
      ? <> — PMR vs <b>{prevDate}</b>. <span style={{ color: 'var(--success)' }}>↑</span> up / <span style={{ color: 'var(--error)' }}>↓</span> down / NEW = not in the prior Top list.</>
      : <> — no prior day yet, so this run is the baseline.</>}
  </p>
);

/** Masked input with show/hide (LLM API key). */
const SecretInput: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string }> = ({ label, value, onChange, placeholder }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <div style={{ position: 'relative' }}>
        <input type={show ? 'text' : 'password'} className="input-text" style={{ paddingRight: '2.5rem' }}
          placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" onClick={() => setShow(!show)}
          style={{ position: 'absolute', right: '0.625rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', padding: '0.25rem' }}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
};

/** Add/remove chip list (email recipients). */
const ManagedList: React.FC<{
  items: string[]; onChange: (items: string[]) => void; defaults: string[];
  placeholder: string; validate?: (v: string) => string | null; collapsedCount?: number;
}> = ({ items, onChange, defaults, placeholder, validate, collapsedCount = 12 }) => {
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState(false);
  const add = () => {
    const values = input.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
    if (!values.length) return;
    for (const v of values) { const msg = validate?.(v); if (msg) { setErr(msg); return; } }
    const merged = [...items];
    for (const v of values) if (!merged.includes(v)) merged.push(v);
    onChange(merged); setInput(''); setErr('');
  };
  const shown = expanded ? items : items.slice(0, collapsedCount);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input type="text" className="input-text" style={{ flex: 1 }} placeholder={placeholder}
          value={input} onChange={(e) => { setInput(e.target.value); setErr(''); }}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
        <button type="button" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }} onClick={add}>
          <Plus size={14} /> Add
        </button>
        <button type="button" className="btn btn-secondary" title="Reset to default list"
          style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }} onClick={() => onChange([...defaults])}>
          <RotateCcw size={14} /> Reset
        </button>
      </div>
      {err && <p style={{ fontSize: '0.75rem', color: 'var(--error)' }}>{err}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
        {shown.map((item) => (
          <span key={item} style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
            background: 'var(--primary-subtle, #e8f1fb)', border: '1px solid #c7ddf5',
            borderRadius: '999px', padding: '0.2rem 0.375rem 0.2rem 0.625rem', fontSize: '0.75rem', fontFamily: 'monospace',
          }}>
            {item}
            <button type="button" onClick={() => onChange(items.filter((i) => i !== item))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-muted)', padding: 0 }} title={`Remove ${item}`}>
              <X size={12} />
            </button>
          </span>
        ))}
        {items.length > collapsedCount && (
          <button type="button" className="btn btn-secondary"
            style={{ padding: '0.2rem 0.625rem', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
            onClick={() => setExpanded(!expanded)}>
            {expanded ? <><ChevronUp size={12} /> Collapse</> : <><ChevronDown size={12} /> Show all {items.length}</>}
          </button>
        )}
      </div>
    </div>
  );
};

/** Numbered / titled section header. */
const SectionHead: React.FC<{ n?: number; title: string; children?: React.ReactNode }> = ({ n, title, children }) => (
  <div className="section-head">
    {n != null && <span className="section-num">{n}</span>}
    <div>
      <h2 className="section-title">{title}</h2>
      {children && <p className="section-sub">{children}</p>}
    </div>
  </div>
);

/** Generic aggregated-table renderer. */
const AggTable: React.FC<{
  rows: AggRow[];
  cols: { label: string; get: (r: AggRow) => React.ReactNode; align?: 'right' }[];
}> = ({ rows, cols }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ background: 'var(--primary)', color: 'white', textAlign: 'left' }}>
          {cols.map((c) => <th key={c.label} style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap', textAlign: c.align ?? 'left' }}>{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ background: i % 2 ? '#f8fafc' : 'white', borderBottom: '1px solid #e5e7eb' }}>
            {cols.map((c) => (
              <td key={c.label} style={{ padding: '0.5rem 0.75rem', textAlign: c.align ?? 'left', fontFamily: c.align === 'right' ? 'monospace' : 'inherit' }}>
                {c.get(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const TopBundleAnalysis: React.FC = () => {
  // ── uploaded Looker file ──
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [parsedRows, setParsedRows] = useState<Record<string, unknown>[]>([]);
  // Column mapping is auto-detected from the fixed Looker export layout (no manual UI).
  const [mapping, setMapping] = useState<Record<CanonicalField, string | undefined>>({} as Record<CanonicalField, string | undefined>);

  // ── Slack auto-fetch (channel + token configured on the backend in server/.env) ──
  const [slackFetching, setSlackFetching] = useState(false);
  // Slack file id of the currently-loaded "today" file — used to skip re-downloading
  // the same file. undefined for a manual upload (no Slack identity).
  const [loadedFileId, setLoadedFileId] = useState<string | undefined>(undefined);

  // ── recipients (persisted) ──
  const [recipients, setRecipientsState] = useState<string[]>(() => loadList(RECIPIENTS_KEY, DEFAULT_EMAIL_RECIPIENTS));
  const setRecipients = (v: string[]) => { setRecipientsState(v); localStorage.setItem(RECIPIENTS_KEY, JSON.stringify(v)); };

  // ── LLM (PubMatic Brain) — configured on the backend (server/.env); no UI here ──
  const llmConfig: LlmConfig = DEFAULT_LLM_CONFIG;

  // ── run params / state ──
  const [reportDate, setReportDate] = useState(getLatestDate());
  const [runState, setRunState] = useState<RunState>('idle');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logExpanded, setLogExpanded] = useState(true);
  const addLog = (level: LogEntry['level'], msg: string) =>
    setLogs((prev) => [...prev, { ts: new Date().toLocaleTimeString('en-GB'), level, msg }]);
  // Guards against a slow AI-narrative call from an earlier run overwriting a newer one.
  const runIdRef = useRef(0);
  // Scroll target so clicking "Analyze" visibly jumps to the live Run Log.
  const runLogRef = useRef<HTMLDivElement>(null);

  // ── results ──
  const [rows, setRows] = useState<BundleRow[]>([]);
  const [summaryText, setSummaryText] = useState('');

  // ── sending (reuses Discrepancy's validated email config) ──
  const [sending, setSending] = useState(false);
  const [emailStatus, setEmailStatus] = useState('');
  const [emailOk, setEmailOk] = useState<boolean | null>(null);
  const sendSettings = useMemo<AppSendSettings>(() => {
    try { const saved = localStorage.getItem(SEND_SETTINGS_KEY); if (saved) return { ...DEFAULT_SEND_SETTINGS, ...JSON.parse(saved) }; } catch { /* ignore */ }
    return { ...DEFAULT_SEND_SETTINGS };
  }, [runState]);

  // ── derived analysis ──
  const summaries = useMemo<ReportSummaries>(() => ({
    topBundles: topBundles(rows),
    topPublishers: topPublishers(rows, 20),
    gckPublishers: gckPublishers(rows, 20),
    byDsp: byDsp(rows), dspGroups: dspWithBundles(rows, 10, 5),
    byCountry: byCountry(rows, 10),
    byRegion: byRegion(rows), byPod: byPod(rows),
    adFormatPivot: adFormatPivot(rows), bundlePublisher: bundlePublisherBreakdown(rows),
  }), [rows]);
  const partner = useMemo(() => partnerList(rows), [rows]);
  const metrics = useMemo(() => computeMetrics(rows), [rows]);
  const [changeMap, setChangeMap] = useState<Record<string, BundleChange>>({});
  const [pubDayOverDay, setPubDayOverDay] = useState<PublisherDayOverDay | null>(null);
  const [gckDayOverDay, setGckDayOverDay] = useState<PublisherDayOverDay | null>(null);
  const [regionDayOverDay, setRegionDayOverDay] = useState<DimDayOverDay | null>(null);
  const [podDayOverDay, setPodDayOverDay] = useState<DimDayOverDay | null>(null);
  const [dspDayOverDay, setDspDayOverDay] = useState<DimDayOverDay | null>(null);
  const [countryDayOverDay, setCountryDayOverDay] = useState<DimDayOverDay | null>(null);
  const [adFormatDayOverDay, setAdFormatDayOverDay] = useState<DimDayOverDay | null>(null);
  const [overallDoD, setOverallDoD] = useState<OverallDoD | null>(null);

  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  const needsBundleOrDomain = !mapping.bundle && !mapping.domain;
  const mappingValid = headers.length > 0 && missingRequired.length === 0 && !needsBundleOrDomain;

  const applyParsed = (parsed: ParsedFile, sourceLabel: string) => {
    setError(''); setRunState('idle'); setRows([]); setSummaryText('');
    const { headers: h, rows: r } = parsed;
    if (!h.length) { setError(`Could not read any columns from ${sourceLabel}.`); return false; }
    const m = autoMap(h);
    setFileName(sourceLabel); setHeaders(h); setParsedRows(r); setMapping(m);
    setLogs([]);
    addLog('info', `Loaded ${sourceLabel}: ${r.length} rows, ${h.length} columns.`);
    addLog('info', `Columns: ${h.join(' | ')}`);
    if (parsed.issues) {
      const bt = Object.entries(parsed.issues.byType).map(([k, v]) => `${v}× ${k}`).join(', ');
      addLog('warn', `Parser flagged ${parsed.issues.count} row issue(s) [${bt}]${parsed.issues.firstRow != null ? `, first at data row ${parsed.issues.firstRow}` : ''} — affected rows may be dropped or misaligned; check the source file for stray tabs/quotes/newlines. e.g. ${parsed.issues.sample.join('  |  ')}`);
    }
    if (m.date) {
      const withDate = r.find((row) => String(row[m.date!] ?? '').trim());
      const d = withDate ? normalizeDate(String(withDate[m.date!])) : '';
      if (d) { setReportDate(d); addLog('info', `Report date from file: ${d}`); }
    }
    return true;
  };

  const handleFile = async (file: File) => {
    try { setLoadedFileId(undefined); applyParsed(await parseFile(file), file.name); }
    catch (err) { setError(`Failed to read file: ${(err as Error).message}`); }
  };

  const handleFetchSlack = async () => {
    setSlackFetching(true); setError('');
    try {
      // Cheap peek first (files.list, no download): if the newest Slack file is the one we
      // already have loaded, skip the large re-download entirely.
      const peek = await peekLatestFromSlack('', '', '');
      if (peek?.fileId && loadedFileId && peek.fileId === loadedFileId) {
        addLog('info', `Latest Slack file unchanged (${peek.filename}) — already loaded, skipped re-download.`);
        return;
      }
      // Channel + match come from server/.env (dev); token from server too.
      const { filename, text, fileId } = await fetchLatestFromSlack('', '', '');
      setLoadedFileId(fileId);
      applyParsed(parseCsvText(text, filename), `Slack: ${filename}`);
    } catch (err) {
      setError(`Slack fetch failed: ${(err as Error).message}`);
      addLog('error', `Slack fetch failed: ${(err as Error).message}`);
    } finally {
      setSlackFetching(false);
    }
  };

  const handleAnalyze = async () => {
    setError(''); setEmailStatus('');
    if (!mappingValid) { setError('Map the required columns first (Platform, Spend, Paid Impressions, and Bundle or Domain).'); return; }
    const myRun = ++runIdRef.current;
    setRunState('analyzing');
    addLog('info', 'Analyze clicked — starting run…');
    // Yield so React actually paints the "Analyzing…" button state + Run Log BEFORE the heavy
    // synchronous parse below (up to ~1M rows) blocks the main thread — otherwise the click
    // looks unresponsive until the log appears. Double rAF = "after the next paint".
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      runLogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      requestAnimationFrame(() => resolve());
    }));

    const std = standardizeMapped(parsedRows, mapping);
    if (!std.length) {
      setError('No usable rows after mapping — check that the Platform column is mapped correctly.');
      addLog('error', 'Standardize produced 0 rows.');
      setRunState('error');
      return;
    }
    setRows(std);

    const plats = [...new Set(std.map((r) => r.platform))];
    addLog('info', `Analyzed ${std.length} rows. Platform values: ${plats.join(', ')}`);
    addLog('info', `In-app rows: ${inApp(std).length} of ${std.length}.`);
    if (inApp(std).length === 0) {
      addLog('warn', 'No rows matched the mobile in-app buckets (Mobile App Android / Mobile App iOS). If your Platform values differ, tell me the exact values and I will map them.');
    }
    const podsSeen = [...new Set(inApp(std).map((r) => r.pod).filter(Boolean))];
    addLog('info', `POD values: ${podsSeen.join(', ') || '(none)'}. GCK POD rows: ${inApp(std).filter((r) => isGckPod(r.pod)).length}.`);

    // Persist today's snapshot immediately (keyed by date) so it survives even if a newer run
    // supersedes this one during the async steps below — day-over-day only diffs EARLIER dates.
    // Record the Slack file id (when the data came from Slack) so a later run can reuse it.
    saveDaySnapshots(reportDate, std, loadedFileId);

    // ── Refresh the day-over-day baseline from the MOST RECENT prior day (by filename date —
    //    auto-skips weekends/holidays/gaps). PEEK the prior file's id first (cheap, no download):
    //    if we already hold a snapshot computed from that exact file, reuse it and skip the large
    //    re-download; only download when the file is new/changed. Keeps the baseline accurate
    //    (tied to file identity) without re-fetching ~200MB every run. Falls back to the stored
    //    snapshot when Slack is unavailable. ──
    const hadStoredBaseline = !!previousDailyTotals(reportDate);
    try {
      const peek = await peekPriorFromSlack(reportDate);
      if (myRun !== runIdRef.current) return;
      const priorStored = peek ? dailyTotalsForDate(peek.date) : null;
      if (!peek) {
        addLog(hadStoredBaseline ? 'warn' : 'info', hadStoredBaseline
          ? 'No earlier TSV in Slack — falling back to the stored snapshot for day-over-day.'
          : 'No earlier TSV in Slack and none on record — running as baseline (no day-over-day).');
      } else if (priorStored && !priorStored.fileId) {
        // A prior-day snapshot with no fileId was saved from a MANUAL upload — i.e. a deliberate
        // correction of a bad/missing Slack file. Treat it as authoritative and never overwrite it
        // from Slack (otherwise a re-run re-downloads the bad file and clobbers the fix). To change
        // this baseline, re-load the file manually for that date.
        addLog('info', `Prior day ${peek.date} baseline was manually uploaded — keeping it, not overwriting from Slack (${peek.filename}).`);
      } else if (priorStored && peek.fileId && priorStored.fileId === peek.fileId) {
        addLog('info', `Prior day ${peek.date} unchanged (${peek.filename}) — baseline reused from cache, no re-download.`);
      } else {
        addLog('info', `Fetching prior day ${peek.date} from Slack (${peek.filename})…`);
        const res = await fetchPriorFromSlack(reportDate);
        if (myRun !== runIdRef.current) return;
        if (res) {
          const pPrev = parseCsvText(res.text, res.filename);
          const stdPrev = standardizeMapped(pPrev.rows, autoMap(pPrev.headers));
          if (stdPrev.length) {
            saveDaySnapshots(res.date, stdPrev, res.fileId);
            addLog('info', `Baseline refreshed from Slack: ${res.date} (${res.filename}, ${stdPrev.length} rows).`);
          } else {
            addLog('warn', `Prior file ${res.filename} produced 0 usable rows — falling back to the stored snapshot.`);
          }
        }
      }
    } catch (e) {
      addLog('warn', `Prior-day fetch failed (${(e as Error).message.slice(0, 120)}) — falling back to the stored snapshot.`);
    }

    // ── Day-over-day vs the most recent prior day on record (diff before saving today) ──
    // Bundle-level (drives the "vs prev" column on Top Bundles).
    const ranked = topBundles(std, 200);
    const prevBundles = previousSnapshot(reportDate);
    const bundleDod = prevBundles ? diffTopN(ranked, prevBundles, 50) : null;
    setChangeMap(bundleChangeMap(ranked, prevBundles, 50));

    // Publisher-level — overall market and GCK POD; plus GCK bundles (for the GCK deep-dive).
    const rankedPubs = topPublishers(std, 100);
    const pubDod = diffPublishers(rankedPubs, previousPublisherSnapshot(reportDate, 'all'), 20);
    setPubDayOverDay(pubDod);
    const rankedGck = gckPublishers(std, 100);
    const gckDod = diffPublishers(rankedGck, previousPublisherSnapshot(reportDate, 'gck'), 20);
    setGckDayOverDay(gckDod);
    const gckBundleDod = diffDim(gckBundles(std, 50), previousDimSnapshot('gckbundle', reportDate), 'appName', 20);

    // Dimension-level — region / POD / DSP / country / ad format (feed the display tables + AI attribution).
    const regionRanked = byRegion(std);
    const podRanked = byPod(std, 30);
    const dspRanked = byDsp(std, 30);
    const countryRanked = byCountry(std, 30);
    const adFormatRanked = byAdFormat(std, 30);
    const regionDod = diffDim(regionRanked, previousDimSnapshot('region', reportDate), 'region', 10);
    // topN 30 matches the By POD table (byPod default) + the saved snapshot, so every
    // displayed POD gets a "vs prev" instead of "—" for ranks 11+.
    const podDod = diffDim(podRanked, previousDimSnapshot('pod', reportDate), 'pod', 30);
    const dspDod = diffDim(dspRanked, previousDimSnapshot('dsp', reportDate), 'dsp', 10);
    const countryDod = diffDim(countryRanked, previousDimSnapshot('country', reportDate), 'country', 10);
    const adFormatDod = diffDim(adFormatRanked, previousDimSnapshot('adFormat', reportDate), 'adFormat', 12);
    setRegionDayOverDay(regionDod);
    setPodDayOverDay(podDod);
    setDspDayOverDay(dspDod);
    setCountryDayOverDay(countryDod);
    setAdFormatDayOverDay(adFormatDod);

    // Overall totals — exact headline PMR DoD % for the executive summary.
    const localMetrics = computeMetrics(std);
    const totals = { inAppSpend: localMetrics.inAppSpend, pmr: localMetrics.inAppPmr, revenue: localMetrics.totalRevenue };
    const overall = overallDayOverDay(totals, previousDailyTotals(reportDate));
    setOverallDoD(overall);

    const dodContext: DoDContext = {
      overall, bundle: bundleDod, publishers: pubDod, gckPublishers: gckDod, gckBundles: gckBundleDod,
      region: regionDod, pod: podDod, dsp: dspDod, country: countryDod, adFormat: adFormatDod,
    };

    // Deterministic executive summary first (immediate render + AI fallback), with attribution.
    setSummaryText(generateStructuredSummary(std, reportDate, dodContext));

    if (overall && overall.pmrDeltaPct !== null) {
      addLog('info', `Overall in-app PMR DoD vs ${overall.prevDate}: ${overall.pmrDeltaPct >= 0 ? '+' : ''}${Math.round(overall.pmrDeltaPct * 100)}% (spend ${overall.spendDeltaPct !== null ? (overall.spendDeltaPct >= 0 ? '+' : '') + Math.round(overall.spendDeltaPct * 100) + '%' : 'n/a'}).`);
    } else {
      addLog('info', 'Day-over-day: no prior day on record — baseline saved.');
    }
    if (localMetrics.inAppPmr <= 0) addLog('warn', 'In-app PMR is $0 — check that the PMR (PubMatic revenue) column is present and mapped, otherwise PMR metrics stay empty.');
    if (bundleDod) addLog('info', `Bundle DoD vs ${bundleDod.prevDate}: ${bundleDod.newEntrants.length} new, ${bundleDod.dropped.length} dropped, ${bundleDod.movers.length} big movers in top 50.`);
    if (pubDod) {
      const ups = pubDod.rows.filter((r) => r.status === 'up').length;
      const downs = pubDod.rows.filter((r) => r.status === 'down').length;
      addLog('info', `Publisher DoD vs ${pubDod.prevDate}: ${ups} up, ${downs} down in top ${pubDod.topN}.`);
    }

    setRunState('done');

    {
      const localSummaries: ReportSummaries = {
        topBundles: topBundles(std),
        topPublishers: topPublishers(std, 20), gckPublishers: gckPublishers(std, 20),
        byDsp: byDsp(std), dspGroups: dspWithBundles(std, 10, 5), byCountry: byCountry(std, 10),
        byRegion: byRegion(std), byPod: byPod(std),
        adFormatPivot: adFormatPivot(std), bundlePublisher: bundlePublisherBreakdown(std),
      };
      addLog('info', `Generating AI narrative via PubMatic Brain (${llmConfig.environment}, ${llmConfig.model})...`);
      try {
        const narrative = await generateNarrative(localSummaries, localMetrics, reportDate, llmConfig, dodContext);
        if (myRun !== runIdRef.current) return;   // a newer run started — don't clobber it
        if (narrative.trim()) { setSummaryText(stripMarkdown(narrative)); addLog('info', 'AI narrative generated'); }
        else addLog('warn', 'AI returned an empty narrative — keeping the structured summary.');
      } catch (e) {
        if (myRun !== runIdRef.current) return;
        addLog('warn', `AI narrative unavailable (${(e as Error).message.slice(0, 150)}) — keeping the structured summary.`);
      }
    }
  };

  const downloadText = (text: string, filename: string, mime: string) => {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    URL.revokeObjectURL(a.href);
  };
  const handleExportPartner = () => {
    const name = TopBundleExcel.generatePartner(partner, reportDate);
    addLog('info', `Exported ${name} (${partner.length} rows, bundle + country + eCPM, no spend)`);
  };
  const handleSendEmail = async () => {
    setSending(true); setEmailStatus(''); setEmailOk(null);
    const emailDoD: EmailDoD = {
      overall: overallDoD, publishers: pubDayOverDay, gckPublishers: gckDayOverDay,
      region: regionDayOverDay, pod: podDayOverDay, dsp: dspDayOverDay,
      country: countryDayOverDay, adFormat: adFormatDayOverDay, bundleChangeMap: changeMap,
    };
    const html = buildEmailHtml(summaries, summaryText, metrics, reportDate, emailDoD);
    const res = await sendEmail({
      subject: buildEmailSubject(reportDate), html,
      // Attachment = the clean, partner-shareable list (no spend), same as the XLSX export.
      csv: partnerCsv(partner), filename: `bundle_list_to_share_${reportDate}.csv`, recipients,
    }, sendSettings);
    if (res.ok) {
      const n = res.recipients?.length ?? recipients.length;
      setEmailStatus(`Sent to ${n} recipient${n === 1 ? '' : 's'}`); setEmailOk(true);
      addLog('info', 'Internal report emailed with the clean Bundle List to Share (CSV) attached');
    } else {
      setEmailStatus(res.error || 'Email failed'); setEmailOk(false); addLog('error', `Email failed: ${res.error}`);
    }
    setSending(false);
  };

  const isAnalyzing = runState === 'analyzing';

  return (
    <div className="ap-shooter-scope">
      <div className="page-header">
        <h1>DoD Performance Change Analysis</h1>
        <p>Upload the daily Looker export (or auto-fetch from Slack) → analyze mobile in-app bundles by publisher, DSP, ad format &amp; size, country, region and POD → export an internal report and a clean, partner-shareable bundle list.</p>
      </div>

      {/* ── 1. import data ── */}
      <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <SectionHead title="Import data">
          Load the daily Looker export in <b>one of two ways</b> — either upload the file yourself, or auto-fetch the latest one from Slack. You only need to do one.
        </SectionHead>

        <div className="import-grid">
          {/* Option A — manual upload */}
          <div className="import-tile">
            <span className="import-tile-tag">Option A</span>
            <span className="import-tile-icon"><FileSpreadsheet size={18} /></span>
            <h3>Upload Looker export</h3>
            <p className="import-tile-desc">
              CSV, TSV or Excel with per-row Spend + Paid Impressions and the dimensions Bundle, Platform, Ad Format, Publisher, Domain.
            </p>
            <label className="btn btn-primary" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
              <Upload size={16} /> Choose CSV / TSV / Excel
              <input type="file" accept=".csv,.tsv,.xlsx,.xls,.xlsm" style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files?.[0]) { handleFile(e.target.files[0]); e.target.value = ''; } }} />
            </label>
          </div>

          {/* Either/or divider */}
          <div className="import-or"><span>OR</span></div>

          {/* Option B — Slack auto-fetch */}
          <div className="import-tile">
            <span className="import-tile-tag">Option B</span>
            <span className="import-tile-icon"><MessageSquare size={18} /></span>
            <h3>Auto-fetch from Slack</h3>
            <p className="import-tile-desc">
              Grabs the newest dated <b>TSV</b> Looker posted to the configured channel (<code>LOOKER_SLACK_CHANNEL</code> in <code>server/.env</code>) — files are named <code>bundle_performance_YYYYMMDD.tsv</code>; the same-name CSV is ignored. The bot needs <code>files:read</code> and must be in the channel. Each run checks the prior day against Slack by file id and only re-downloads it if it changed — accurate baseline, no wasted re-fetch.
            </p>
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }}
              onClick={handleFetchSlack} disabled={slackFetching}>
              {slackFetching ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              {slackFetching ? 'Fetching…' : 'Fetch latest from Slack'}
            </button>
          </div>
        </div>

        {fileName && (
          <>
            <div className="source-bar">
              <CheckCircle2 size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
              <span><b>{fileName}</b> — {parsedRows.length.toLocaleString()} rows loaded</span>
            </div>
            {(missingRequired.length > 0 || needsBundleOrDomain) ? (
              <p style={{ fontSize: '0.8125rem', color: 'var(--error)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                <AlertTriangle size={15} /> This file is missing expected columns: {[...missingRequired.map((f) => FIELD_LABELS[f]), needsBundleOrDomain ? 'Bundle or Domain' : ''].filter(Boolean).join(', ')}. Check that it&apos;s the standard Looker export.
              </p>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }} onClick={handleAnalyze} disabled={!mappingValid || isAnalyzing}>
                  {isAnalyzing ? <Loader2 size={16} className="animate-spin" /> : <BarChart3 size={16} />}
                  {isAnalyzing ? 'Analyzing...' : 'Analyze'}
                </button>
                {isAnalyzing && (
                  <span style={{ fontSize: 'var(--text-ui)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                    <Loader2 size={14} className="animate-spin" /> Running — progress shows in the Run Log below.
                  </span>
                )}
                {runState === 'done' && (
                  <span style={{ fontSize: 'var(--text-ui)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                    <CheckCircle2 size={14} /> Analysis complete — see the results below.
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── email recipients management (same treatment as Discrepancy Check-in) ── */}
      <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h2 style={{ fontSize: 'var(--text-h3)', fontWeight: 600 }}>Email Recipients ({recipients.length})</h2>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
          Where the internal analysis (with spend + eCPM) is sent. Uses the email config from Discrepancy Check-in. Add or remove as needed; changes are saved automatically.
        </p>
        <ManagedList
          items={recipients}
          onChange={setRecipients}
          defaults={DEFAULT_EMAIL_RECIPIENTS}
          placeholder="Enter email address (comma/space separated for bulk add)"
          validate={(v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : `"${v}" is not a valid email address`)}
          collapsedCount={20}
        />
      </div>

      {error && (
        <div className="glass-card" style={{ borderLeft: '4px solid var(--error)', color: 'var(--error)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      {/* ── run log ── */}
      {logs.length > 0 && (
        <div ref={runLogRef} className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Terminal size={18} /> Run Log ({logs.length})
            </h2>
            <button className="btn btn-secondary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }} onClick={() => setLogExpanded(!logExpanded)}>
              {logExpanded ? <><ChevronUp size={13} /> Collapse</> : <><ChevronDown size={13} /> Expand</>}
            </button>
          </div>
          {logExpanded && (
            <div style={{ background: '#0f172a', borderRadius: '0.5rem', padding: '0.75rem 1rem', maxHeight: '260px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.75rem', lineHeight: 1.7 }}>
              {logs.map((l, i) => (
                <div key={i} style={{ whiteSpace: 'pre-wrap', color: LOG_COLORS[l.level] }}>
                  <span style={{ color: '#64748b' }}>[{l.ts}]</span> <span style={{ fontWeight: l.level === 'error' ? 700 : 400 }}>{l.level.toUpperCase().padEnd(5)}</span> {l.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── results ── */}
      {runState === 'done' && rows.length > 0 && (
        <>
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <CheckCircle2 size={22} style={{ color: 'var(--success)' }} />
                <h2 style={{ fontSize: '1.15rem', fontWeight: 600 }}>{reportDate} — Analysis ready</h2>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={handleExportPartner}>
                  <Share2 size={16} /> Export Bundle List to Share (XLSX)
                </button>
              </div>
            </div>

            <div className="stat-row">
              {[
                { label: 'In-app DSP spend', value: fmtCurrency(metrics.inAppSpend) },
                { label: 'PMR (PubMatic rev)', value: fmtCurrency(metrics.totalPmr) },
                { label: 'Publisher rev', value: fmtCurrency(metrics.totalRevenue) },
                { label: 'Distinct bundles', value: metrics.distinctBundles.toLocaleString() },
              ].map((s) => (
                <div className="stat-tile" key={s.label}>
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value">{s.value}</div>
                </div>
              ))}
            </div>

            <div style={{ background: 'var(--bg-subtle, #f5f5f5)', borderLeft: '4px solid var(--primary)', padding: '1rem 1.25rem', borderRadius: '0 0.5rem 0.5rem 0' }}>
              <p style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>Insights</p>
              <InsightsBody text={summaryText} />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1.5rem' }}
                onClick={handleSendEmail} disabled={sending || !recipients.length}>
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {sending ? 'Sending...' : 'Email internal report'}
              </button>
              {emailStatus && (
                <span style={{ fontSize: '0.8125rem', display: 'inline-flex', alignItems: 'center', gap: '0.375rem', color: emailOk ? 'var(--success)' : 'var(--error)' }}>
                  {emailOk ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                  {emailStatus}
                </span>
              )}
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
              Email body = the internal analysis (with spend) for the team. Attached is the clean Bundle List to Share (bundle + country + eCPM, no spend) that you can forward to partners.
            </p>
          </div>

          {/* 2-3. Region / POD */}
          <div className="grid-2">
            <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>2. By Region</h2>
              <AggTable rows={summaries.byRegion} cols={[
                { label: 'Region', get: (r) => r.region },
                { label: 'DSP Spend', get: (r) => fmtCurrency(r.spend), align: 'right' },
                { label: 'DSP %', get: (r) => fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0), align: 'right' },
                { label: 'PMR', get: (r) => fmtCurrency(r.pmr), align: 'right' },
                { label: 'PMR %', get: (r) => fmtPct(metrics.inAppPmr > 0 ? r.pmr / metrics.inAppPmr : 0), align: 'right' },
                { label: 'vs prev', get: (r) => <ChangeIndicator c={dimChangeOf(regionDayOverDay, String(r.region ?? ''))} />, align: 'right' },
                { label: 'eCPM', get: (r) => fmtEcpm(r.ecpm), align: 'right' },
              ]} />
            </div>
            <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>3. By POD</h2>
              <AggTable rows={summaries.byPod} cols={[
                { label: 'POD', get: (r) => r.pod },
                { label: 'Region', get: (r) => r.region },
                { label: 'DSP Spend', get: (r) => fmtCurrency(r.spend), align: 'right' },
                { label: 'DSP %', get: (r) => fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0), align: 'right' },
                { label: 'PMR', get: (r) => fmtCurrency(r.pmr), align: 'right' },
                { label: 'PMR %', get: (r) => fmtPct(metrics.inAppPmr > 0 ? r.pmr / metrics.inAppPmr : 0), align: 'right' },
                { label: 'vs prev', get: (r) => <ChangeIndicator c={dimChangeOf(podDayOverDay, String(r.pod ?? ''))} />, align: 'right' },
                { label: 'eCPM', get: (r) => fmtEcpm(r.ecpm), align: 'right' },
              ]} />
            </div>
          </div>

          {/* 4. By DSP (Top 10) -> each with its Top 5 bundles */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>4. By DSP (Top {summaries.dspGroups.length}, each with Top 5 bundles)</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--primary)', color: 'white' }}>
                    {['DSP / Bundle', 'DSP Spend', 'DSP %', 'PMR', 'PMR %', 'vs prev', 'eCPM'].map((h, i) => (
                      <th key={h} style={{ padding: '0.5rem 0.75rem', textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summaries.dspGroups.map((g) => (
                    <React.Fragment key={g.dsp}>
                      <tr style={{ background: '#eef2f8', fontWeight: 700 }}>
                        <td style={{ padding: '0.5rem 0.75rem' }}>{g.dsp}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(g.spend)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(g.spendShare)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(g.pmr)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(g.pmrShare)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}><ChangeIndicator c={dimChangeOf(dspDayOverDay, g.dsp)} /></td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(g.ecpm)}</td>
                      </tr>
                      {g.rows.map((b, j) => (
                        <tr key={g.dsp + j} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '0.4rem 0.75rem 0.4rem 1.75rem', color: 'var(--text-secondary)' }}>{b.appName} <span style={{ color: '#999', fontFamily: 'monospace' }}>{b.bundle}</span></td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(b.spend)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(b.spendShareOfDsp)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(b.pmr)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(b.pmrShareOfDsp)}</td>
                          <td />
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(b.ecpm)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>Group rows = share of total in-app (DSP % of spend, PMR % of PMR) with PMR vs prev; indented bundle rows = share within that DSP.</p>
          </div>

          {/* 5. Publisher day-over-day — overall market Top 20 (大盘 Top 20) */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>5. Publisher Day-over-Day Changes — Overall Top {summaries.topPublishers.length}</h2>
            <DodCaption prevDate={pubDayOverDay?.prevDate} label={`Whole-market Top ${summaries.topPublishers.length} publishers, ranked by in-app PMR`} />
            <DodTable firstCol="Publisher" rows={pubDodRows(summaries.topPublishers, pubDayOverDay)} totalSpend={metrics.inAppSpend} totalPmr={metrics.inAppPmr} />
          </div>

          {/* 6. GCK POD Top 20 publishers */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>6. GCK POD — Top {summaries.gckPublishers.length} Publishers</h2>
            {summaries.gckPublishers.length === 0 ? (
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>No rows matched the GCK POD. Check the POD column values listed in the Run Log.</p>
            ) : (
              <>
                <DodCaption prevDate={gckDayOverDay?.prevDate} label={`GCK POD publishers only, ranked by in-app PMR`} />
                <DodTable firstCol="Publisher" rows={pubDodRows(summaries.gckPublishers, gckDayOverDay)} totalSpend={metrics.inAppSpend} totalPmr={metrics.inAppPmr} />
              </>
            )}
          </div>

          {/* 7. Top Bundles (Top 20) merged with publisher breakdown + DoD */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>7. Top Bundles (Top {summaries.bundlePublisher.length})</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--primary)', color: 'white' }}>
                    {['App / Publisher', 'Ad Formats', 'DSP Spend', 'DSP %', 'PMR', 'PMR %', 'eCPM', 'vs prev'].map((h, i) => (
                      <th key={h} style={{ padding: '0.5rem 0.75rem', textAlign: i >= 2 ? 'right' : 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summaries.bundlePublisher.map((g) => (
                    <React.Fragment key={g.bundle}>
                      <tr style={{ background: '#eef2f8', fontWeight: 700 }}>
                        <td style={{ padding: '0.5rem 0.75rem' }}>{g.appName} <span style={{ color: '#777', fontWeight: 400, fontFamily: 'monospace' }}>{g.bundle}</span></td>
                        <td />
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(g.spend)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(g.spendShare)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(g.pmr)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(g.pmrShare)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(g.ecpm)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}><ChangeIndicator c={changeMap[String(g.bundle ?? '')] ?? null} /></td>
                      </tr>
                      {g.rows.map((r, j) => (
                        <tr key={g.bundle + j} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '0.4rem 0.75rem 0.4rem 1.75rem', color: 'var(--text-secondary)' }}>{r.publisher}</td>
                          <td style={{ padding: '0.4rem 0.75rem' }}>{r.formats.join(', ')}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(r.spend)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(r.spendShareOfBundle)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(r.pmr)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(r.pmrShareOfBundle)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(r.ecpm)}</td>
                          <td />
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>Group rows = share of total in-app (DSP % / PMR %); indented publisher rows = share within that bundle. &quot;vs prev&quot; = the bundle&apos;s PMR day-over-day change.</p>
          </div>

          {/* 8. By Country (Top 10) with DoD */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>8. By Country (Top {summaries.byCountry.length})</h2>
            <DodCaption prevDate={countryDayOverDay?.prevDate} label={`Top ${summaries.byCountry.length} countries, ranked by in-app PMR`} />
            <DodTable firstCol="Country" rows={dimDodRows(summaries.byCountry, countryDayOverDay, 'country')} totalSpend={metrics.inAppSpend} totalPmr={metrics.inAppPmr} />
          </div>

          {/* 9. Ad Format -> Size pivot (Display capped to Top 5 sizes) */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>9. By Ad Format &amp; Size</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--primary)', color: 'white' }}>
                    {['Ad Format / Size', 'DSP Spend', 'DSP %', 'PMR', 'PMR %', 'vs prev', 'eCPM'].map((h, i) => (
                      <th key={h} style={{ padding: '0.5rem 0.75rem', textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summaries.adFormatPivot.map((g) => (
                    <React.Fragment key={g.adFormat}>
                      <tr style={{ background: '#eef2f8', fontWeight: 700 }}>
                        <td style={{ padding: '0.5rem 0.75rem' }}>{g.adFormat}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(g.spend)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(g.spendShare)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(g.pmr)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(g.pmrShare)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}><ChangeIndicator c={dimChangeOf(adFormatDayOverDay, g.adFormat)} /></td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(g.ecpm)}</td>
                      </tr>
                      {g.sizes.map((s) => (
                        <tr key={g.adFormat + s.adSize} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '0.4rem 0.75rem 0.4rem 1.75rem', color: 'var(--text-secondary)' }}>{s.adSize}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(s.spend)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(s.spendShareOfFormat)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(s.pmr)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(s.pmrShareOfFormat)}</td>
                          <td />
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(s.ecpm)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>Format rows = share of total in-app (DSP % / PMR %) with PMR vs prev; size rows = share within that format. Display is limited to its Top 5 sizes. Multi-format rows (e.g. &quot;Display + Native + Video&quot;) are multi-format requests.</p>
          </div>

          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>Bundle List to Share ({partner.length}) — safe to share</h2>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
              In-app bundle × country with eCPM (for partner reference). No spend or DSP data. Top 500 by spend; full list is in the exported XLSX (&quot;Bundle List to Share&quot; sheet).
            </p>
            <div style={{ overflowX: 'auto', maxHeight: '360px' }}>
              <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--primary)', color: 'white', textAlign: 'left', position: 'sticky', top: 0 }}>
                    {['Bundle ID', 'App Name', 'Platform', 'Country', 'eCPM'].map((h) => <th key={h} style={{ padding: '0.5rem 0.75rem' }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {partner.slice(0, 200).map((p, i) => (
                    <tr key={i} style={{ background: i % 2 ? '#f8fafc' : 'white', borderBottom: '1px solid #e5e7eb' }}>
                      <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace' }}>{p.bundle}</td>
                      <td style={{ padding: '0.5rem 0.75rem' }}>{p.appName}</td>
                      <td style={{ padding: '0.5rem 0.75rem' }}>{p.platform}</td>
                      <td style={{ padding: '0.5rem 0.75rem' }}>{p.country}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(p.ecpm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default TopBundleAnalysis;

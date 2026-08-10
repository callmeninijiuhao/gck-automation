import React, { useMemo, useState } from 'react';
import {
  Upload, Send, Eye, EyeOff, X, Plus, RotateCcw, AlertTriangle,
  CheckCircle2, Loader2, ChevronDown, ChevronUp, Terminal, FileSpreadsheet, Share2, BarChart3,
  MessageSquare, RefreshCw, ArrowUp, ArrowDown,
} from 'lucide-react';
import { parseFile, parseCsvText, autoMap, FIELD_LABELS, REQUIRED_FIELDS, CanonicalField, ParsedFile } from '@/services/top-bundle/fileParser';
import { fetchLatestFromSlack } from '@/services/top-bundle/slackFetch';
import {
  standardizeMapped, topBundles, topPublishers, byDsp, byCountry, byRegion, byPod,
  adFormatPivot, bundlePublisherBreakdown, partnerList, computeMetrics, generateStructuredSummary, inApp,
  fmtCurrency, fmtEcpm, fmtPct,
} from '@/services/top-bundle/dataProcessor';
import {
  saveSnapshot, previousSnapshot, diffTopN, bundleChangeMap, changeLabel, BundleChange,
  savePublisherSnapshot, previousPublisherSnapshot, diffPublishers, PublisherDayOverDay, PublisherChange,
} from '@/services/top-bundle/history';
import {
  buildEmailHtml, buildEmailSubject, partnerCsv, ReportSummaries,
} from '@/services/top-bundle/reportBuilder';
import { TopBundleExcel } from '@/services/top-bundle/excelGenerator';
import { generateNarrative, LlmConfig, DEFAULT_LLM_CONFIG } from '@/services/top-bundle/llmService';
import { AggRow, BundleRow } from '@/services/top-bundle/types';
import { DEFAULT_EMAIL_RECIPIENTS } from '@/services/top-bundle/defaults';
import { sendEmail } from '@/services/discrepancy/backendService';
import { isTauri, AppSendSettings, DEFAULT_SEND_SETTINGS } from '@/services/discrepancy/nativeBridge';

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

/** Strip Markdown decoration (#, **, *, _, `) from the AI narrative — the Insights
    box renders plain text, so raw Markdown symbols would just show up literally. */
function stripMarkdown(s: string): string {
  return s
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // ATX headings (# .. ######)
    .replace(/\*\*([^*]+)\*\*/g, '$1')        // **bold**
    .replace(/__([^_]+)__/g, '$1')            // __bold__
    .replace(/\*([^*]+)\*/g, '$1')            // *italic*
    .replace(/`([^`]+)`/g, '$1')              // `code`
    .replace(/^\s{0,3}[-*]\s+/gm, '• ')       // list bullets -> •
    .trim();
}

/** Coloured up/down/new arrow for a publisher's day-over-day spend change. */
const ChangeIndicator: React.FC<{ c: PublisherChange }> = ({ c }) => {
  if (c.status === 'new') return <span style={{ color: 'var(--primary)', fontWeight: 600 }}>NEW</span>;
  if (c.spendDeltaPct === null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const pct = Math.abs(Math.round(c.spendDeltaPct * 100));
  if (c.status === 'up') return <span style={{ color: 'var(--success)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.15rem', justifyContent: 'flex-end' }}><ArrowUp size={14} />{pct}%</span>;
  if (c.status === 'down') return <span style={{ color: 'var(--error)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.15rem', justifyContent: 'flex-end' }}><ArrowDown size={14} />{pct}%</span>;
  return <span style={{ color: 'var(--text-muted)' }}>flat</span>;
};

// ── Insights rendering ──
// The AI briefing labels its sections in Title Case ("Executive Summary"), the
// deterministic summary has none, and some models shout in ALL CAPS — treat all
// three as section headings.
const SECTION_TITLES = /^(executive summary|key findings?|key takeaways?|recommendations?|summary|findings?|overview|next steps)\s*:?$/i;
const isInsightHeading = (l: string) =>
  SECTION_TITLES.test(l) || (/^[A-Z0-9][A-Z0-9 ,&/()\-]{2,39}:?$/.test(l) && !/[a-z]/.test(l));
const insightBullet = (l: string) => l.match(/^(?:[•\-*]|\d+\.)\s+(.*)$/);

/** Bold a short leading "Label:" prefix (e.g. "By region: …") for scannability. */
const emphasizeLabel = (s: string): React.ReactNode => {
  const m = s.match(/^([A-Za-z][A-Za-z ()/&-]{1,38}?):\s+(.*)$/);
  return m ? <><strong>{m[1]}:</strong> {m[2]}</> : s;
};

/** Render the Insights narrative professionally: ALL-CAPS lines become section
    subheadings, "• / - / 1." lines become hanging bullets, and "Label:" prefixes
    are emphasised. Handles both the AI briefing and the deterministic summary. */
const InsightsBody: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
      {lines.map((line, i) => {
        const b = insightBullet(line);
        const core = b ? b[1] : line;   // a heading may arrive wrapped as a bullet ("• Executive Summary")
        if (isInsightHeading(core)) {
          return (
            <p key={i} style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--primary)', margin: i === 0 ? '0 0 0.4rem' : '1rem 0 0.4rem' }}>
              {core.replace(/:$/, '')}
            </p>
          );
        }
        if (b) {
          return (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', margin: '0.3rem 0', lineHeight: 1.6, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--primary)', flexShrink: 0 }}>•</span>
              <span>{emphasizeLabel(b[1])}</span>
            </div>
          );
        }
        return <p key={i} style={{ margin: '0.4rem 0', lineHeight: 1.65 }}>{emphasizeLabel(line)}</p>;
      })}
    </div>
  );
};

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
  placeholder: string; validate?: (v: string) => string | null;
}> = ({ items, onChange, defaults, placeholder, validate }) => {
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const add = () => {
    const values = input.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
    if (!values.length) return;
    for (const v of values) { const msg = validate?.(v); if (msg) { setErr(msg); return; } }
    const merged = [...items];
    for (const v of values) if (!merged.includes(v)) merged.push(v);
    onChange(merged); setInput(''); setErr('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input type="text" className="input-text" style={{ flex: 1 }} placeholder={placeholder}
          value={input} onChange={(e) => { setInput(e.target.value); setErr(''); }}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
        <button type="button" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }} onClick={add}>
          <Plus size={14} /> Add
        </button>
        <button type="button" className="btn btn-secondary" title="Reset to defaults"
          style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }} onClick={() => onChange([...defaults])}>
          <RotateCcw size={14} /> Reset
        </button>
      </div>
      {err && <p style={{ fontSize: '0.75rem', color: 'var(--error)' }}>{err}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
        {items.map((item) => (
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
    topPublishers: topPublishers(rows),
    byDsp: byDsp(rows), byCountry: byCountry(rows),
    byRegion: byRegion(rows), byPod: byPod(rows),
    adFormatPivot: adFormatPivot(rows), bundlePublisher: bundlePublisherBreakdown(rows),
  }), [rows]);
  const partner = useMemo(() => partnerList(rows), [rows]);
  const metrics = useMemo(() => computeMetrics(rows), [rows]);
  const [changeMap, setChangeMap] = useState<Record<string, BundleChange>>({});
  const [pubDayOverDay, setPubDayOverDay] = useState<PublisherDayOverDay | null>(null);

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
    if (m.date) {
      const withDate = r.find((row) => String(row[m.date!] ?? '').trim());
      const d = withDate ? normalizeDate(String(withDate[m.date!])) : '';
      if (d) { setReportDate(d); addLog('info', `Report date from file: ${d}`); }
    }
    return true;
  };

  const handleFile = async (file: File) => {
    try { applyParsed(await parseFile(file), file.name); }
    catch (err) { setError(`Failed to read file: ${(err as Error).message}`); }
  };

  const handleFetchSlack = async () => {
    setSlackFetching(true); setError('');
    try {
      // Channel + match come from server/.env (dev); token from server too.
      const { filename, text } = await fetchLatestFromSlack('', '', '');
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
    setRunState('analyzing');

    const std = standardizeMapped(parsedRows, mapping);
    if (!std.length) {
      setError('No usable rows after mapping — check that the Platform column is mapped correctly.');
      addLog('error', 'Standardize produced 0 rows.');
      setRunState('error');
      return;
    }
    setRows(std);
    setSummaryText(generateStructuredSummary(std, reportDate));

    const plats = [...new Set(std.map((r) => r.platform))];
    addLog('info', `Analyzed ${std.length} rows. Platform values: ${plats.join(', ')}`);
    addLog('info', `In-app rows: ${inApp(std).length} of ${std.length}.`);
    if (inApp(std).length === 0) {
      addLog('warn', 'No rows matched the mobile in-app buckets (Mobile App Android / Mobile App iOS). If your Platform values differ, tell me the exact values and I will map them.');
    }

    // Day-over-day vs the most recent prior run.
    const ranked = topBundles(std, 200);
    const prev = previousSnapshot(reportDate);
    const dod = prev ? diffTopN(ranked, prev, 50) : null;
    setChangeMap(bundleChangeMap(ranked, prev, 50));
    saveSnapshot(reportDate, ranked);
    if (dod) addLog('info', `Day-over-day vs ${dod.prevDate}: ${dod.newEntrants.length} new, ${dod.dropped.length} dropped, ${dod.movers.length} big movers in top 50.`);
    else addLog('info', 'Day-over-day: no prior day on record — baseline saved.');

    // Publisher-level day-over-day (shown in the results — easier to read than bundles).
    const rankedPubs = topPublishers(std, 100);
    const prevPubs = previousPublisherSnapshot(reportDate);
    const pubDod = diffPublishers(rankedPubs, prevPubs, 20);
    setPubDayOverDay(pubDod);
    savePublisherSnapshot(reportDate, rankedPubs);
    if (pubDod) {
      const ups = pubDod.rows.filter((r) => r.status === 'up').length;
      const downs = pubDod.rows.filter((r) => r.status === 'down').length;
      addLog('info', `Publisher day-over-day vs ${pubDod.prevDate}: ${ups} up, ${downs} down in top ${pubDod.topN}.`);
    }

    setRunState('done');

    {
      const localSummaries: ReportSummaries = {
        topBundles: topBundles(std),
        topPublishers: topPublishers(std), byDsp: byDsp(std), byCountry: byCountry(std),
        byRegion: byRegion(std), byPod: byPod(std),
        adFormatPivot: adFormatPivot(std), bundlePublisher: bundlePublisherBreakdown(std),
      };
      const localMetrics = computeMetrics(std);
      addLog('info', `Generating AI narrative via PubMatic Brain (${llmConfig.environment}, ${llmConfig.model})...`);
      try {
        const narrative = await generateNarrative(localSummaries, localMetrics, reportDate, llmConfig, dod);
        if (narrative.trim()) { setSummaryText(stripMarkdown(narrative)); addLog('info', 'AI narrative generated'); }
        else addLog('warn', 'AI returned an empty narrative — keeping the structured summary.');
      } catch (e) {
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
    const html = buildEmailHtml(summaries, summaryText, metrics, reportDate, pubDayOverDay, changeMap);
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
        <h1>Bundle Level Analysis</h1>
        <p>Upload the daily Looker export (or auto-fetch from Slack) → analyze mobile in-app bundles by publisher, DSP, ad format &amp; size, country, region and POD → export an internal report and a clean, partner-shareable bundle list.</p>
      </div>

      {/* ── 1. import data ── */}
      <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <SectionHead title="Import data">
          Load the daily Looker export — upload the file directly, or auto-fetch the latest one posted to Slack.
        </SectionHead>

        <div className="import-grid">
          {/* Option A — manual upload */}
          <div className="import-tile">
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

          {/* Option B — Slack auto-fetch */}
          <div className="import-tile">
            <span className="import-tile-icon"><MessageSquare size={18} /></span>
            <h3>Auto-fetch from Slack</h3>
            <p className="import-tile-desc">
              Grabs the newest CSV/TSV Looker posted to the configured channel (<code>LOOKER_SLACK_CHANNEL</code> in <code>server/.env</code>), preferring TSV. The bot needs <code>files:read</code> and must be in the channel.
            </p>
            <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }}
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
              <div>
                <button className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }} onClick={handleAnalyze} disabled={!mappingValid || isAnalyzing}>
                  {isAnalyzing ? <Loader2 size={16} className="animate-spin" /> : <BarChart3 size={16} />}
                  {isAnalyzing ? 'Analyzing...' : 'Analyze'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── recipients (config, not a pipeline step) ── */}
      <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <SectionHead title="Email Recipients Management">
          Where the internal analysis (with spend + eCPM) is sent. Uses the email config from Discrepancy Check-in.
        </SectionHead>
        <ManagedList items={recipients} onChange={setRecipients} defaults={DEFAULT_EMAIL_RECIPIENTS}
          placeholder="Enter email (comma/space separated for bulk add)"
          validate={(v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : `"${v}" is not a valid email`)} />
      </div>

      {error && (
        <div className="glass-card" style={{ borderLeft: '4px solid var(--error)', color: 'var(--error)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      {/* ── run log ── */}
      {logs.length > 0 && (
        <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
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

          {/* Top 20 Publishers */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>Top {summaries.topPublishers.length} Publishers</h2>
            <AggTable rows={summaries.topPublishers} cols={[
              { label: 'Publisher', get: (r) => r.publisher },
              { label: 'DSP Spend', get: (r) => fmtCurrency(r.spend), align: 'right' },
              { label: 'Contribution', get: (r) => fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0), align: 'right' },
              { label: 'PMR', get: (r) => fmtCurrency(r.pmr), align: 'right' },
              { label: 'Pub Revenue', get: (r) => fmtCurrency(r.revenue), align: 'right' },
              { label: 'eCPM', get: (r) => fmtEcpm(r.ecpm), align: 'right' },
            ]} />
          </div>

          {/* Region / POD */}
          <div className="grid-2">
            <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>By Region</h2>
              <AggTable rows={summaries.byRegion} cols={[
                { label: 'Region', get: (r) => r.region },
                { label: 'DSP Spend', get: (r) => fmtCurrency(r.spend), align: 'right' },
                { label: 'Contribution', get: (r) => fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0), align: 'right' },
                { label: 'PMR', get: (r) => fmtCurrency(r.pmr), align: 'right' },
                { label: 'eCPM', get: (r) => fmtEcpm(r.ecpm), align: 'right' },
              ]} />
            </div>
            <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>By POD</h2>
              <AggTable rows={summaries.byPod} cols={[
                { label: 'POD', get: (r) => r.pod },
                { label: 'Region', get: (r) => r.region },
                { label: 'DSP Spend', get: (r) => fmtCurrency(r.spend), align: 'right' },
                { label: 'Contribution', get: (r) => fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0), align: 'right' },
                { label: 'eCPM', get: (r) => fmtEcpm(r.ecpm), align: 'right' },
              ]} />
            </div>
          </div>

          {/* Day-over-day — by publisher (a bundle alone doesn't tell you the publisher) */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>Publisher day-over-day changes{pubDayOverDay ? ` (top ${pubDayOverDay.rows.length})` : ''}</h2>
            {!pubDayOverDay ? (
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>No prior day on record — this run is the baseline for future comparisons.</p>
            ) : (
              <>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>DSP spend vs <b>{pubDayOverDay.prevDate}</b>. <span style={{ color: 'var(--success)' }}>↑</span> up / <span style={{ color: 'var(--error)' }}>↓</span> down / NEW = not in top publishers previously.</p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--primary)', color: 'white', textAlign: 'left' }}>
                        {['Publisher', 'DSP Spend', 'Contribution', 'vs prev'].map((h, i) => (
                          <th key={h} style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap', textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pubDayOverDay.rows.map((r, i) => (
                        <tr key={r.publisher || i} style={{ background: i % 2 ? '#f8fafc' : 'white', borderBottom: '1px solid #e5e7eb' }}>
                          <td style={{ padding: '0.5rem 0.75rem' }}>{r.publisher || '(unknown)'}</td>
                          <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(r.spend)}</td>
                          <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0)}</td>
                          <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}><ChangeIndicator c={r} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>Top In-App Bundles (top {summaries.topBundles.length})</h2>
            <AggTable rows={summaries.topBundles} cols={[
              { label: 'Bundle', get: (r) => r.bundle },
              { label: 'App', get: (r) => r.appName },
              { label: 'Platform', get: (r) => r.platform },
              { label: 'DSP Spend', get: (r) => fmtCurrency(r.spend), align: 'right' },
              { label: 'Contribution', get: (r) => fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0), align: 'right' },
              { label: 'eCPM', get: (r) => fmtEcpm(r.ecpm), align: 'right' },
              { label: 'vs prev', get: (r) => changeLabel(changeMap[String(r.bundle ?? '')]), align: 'right' },
            ]} />
          </div>

          <div className="grid-2">
            <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>By DSP</h2>
              <AggTable rows={summaries.byDsp} cols={[
                { label: 'DSP', get: (r) => r.dsp },
                { label: 'DSP Spend', get: (r) => fmtCurrency(r.spend), align: 'right' },
                { label: 'Contribution', get: (r) => fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0), align: 'right' },
                { label: 'eCPM', get: (r) => fmtEcpm(r.ecpm), align: 'right' },
              ]} />
            </div>
            <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>By Country</h2>
              <AggTable rows={summaries.byCountry} cols={[
                { label: 'Country', get: (r) => r.country },
                { label: 'DSP Spend', get: (r) => fmtCurrency(r.spend), align: 'right' },
                { label: 'Contribution', get: (r) => fmtPct(metrics.inAppSpend > 0 ? r.spend / metrics.inAppSpend : 0), align: 'right' },
                { label: 'eCPM', get: (r) => fmtEcpm(r.ecpm), align: 'right' },
              ]} />
            </div>
          </div>

          {/* Ad Format -> Size pivot */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>By Ad Format &amp; Size</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--primary)', color: 'white' }}>
                    {['Ad Format / Size', 'DSP Spend', 'Contribution', 'eCPM'].map((h, i) => (
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
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(g.share)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(g.ecpm)}</td>
                      </tr>
                      {g.sizes.map((s) => (
                        <tr key={g.adFormat + s.adSize} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '0.4rem 0.75rem 0.4rem 1.75rem', color: 'var(--text-secondary)' }}>{s.adSize}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(s.spend)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(s.shareOfFormat)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(s.ecpm)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>Format rows = % of total in-app spend; size rows = % within that format. Multi-format rows (e.g. &quot;Display + Native + Video&quot;) are our multi-format requests.</p>
          </div>

          {/* By Bundle & Publisher (hierarchical: bundle -> publisher x ad format) */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>By Bundle &amp; Publisher (top {summaries.bundlePublisher.length})</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--primary)', color: 'white' }}>
                    {['App / Publisher', 'Ad Formats', '% of bundle', 'DSP Spend', 'Contribution', 'eCPM'].map((h, i) => (
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
                        <td />
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(g.spend)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(g.share)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(g.ecpm)}</td>
                      </tr>
                      {g.rows.map((r, j) => (
                        <tr key={g.bundle + j} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '0.4rem 0.75rem 0.4rem 1.75rem', color: 'var(--text-secondary)' }}>{r.publisher}</td>
                          <td style={{ padding: '0.4rem 0.75rem' }}>{r.formats.join(', ')}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtPct(r.shareOfBundle)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtCurrency(r.spend)}</td>
                          <td />
                          <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>{fmtEcpm(r.ecpm)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
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

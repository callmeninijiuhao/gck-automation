import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  Play, Upload, Download, Send, Eye, EyeOff, X, Plus, RotateCcw,
  AlertTriangle, CheckCircle2, Loader2, ChevronDown, ChevronUp, Terminal, Settings,
} from 'lucide-react';
import { DiscrepancyRow, DiscrepancyTokens, DISCREPANCY_CONFIG } from '@/services/discrepancy/types';
import { fetchAllPublishers, diagnoseError } from '@/services/discrepancy/apiService';
import {
  filterLowSpendRows, aggregateByDsp, getTopSpenders, getHighlights,
  generateStructuredSummary, rowsToCsv, getLatestAvailableDate, fmtNum, fmtPct,
} from '@/services/discrepancy/dataProcessor';
import { buildEmailHtml, buildEmailSubject, buildSlackBlocks } from '@/services/discrepancy/reportBuilder';
import { sendEmail, sendSlack } from '@/services/discrepancy/backendService';
import { isTauri, AppSendSettings, DEFAULT_SEND_SETTINGS, getSendConfig, SendConfigStatus } from '@/services/discrepancy/nativeBridge';
import { DEFAULT_PUBLISHER_IDS, DEFAULT_EMAIL_RECIPIENTS } from '@/services/discrepancy/defaults';

const PUB_LIST_KEY = 'discrepancy_publisher_ids';
const RECIPIENTS_KEY = 'discrepancy_email_recipients';
const SEND_SETTINGS_KEY = 'discrepancy_send_settings';

type RunState = 'idle' | 'fetching' | 'analyzing' | 'done' | 'error';

interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const LOG_COLORS: Record<LogEntry['level'], string> = {
  info: '#9ca3af',
  warn: '#d97706',
  error: '#dc2626',
};

const loadList = (key: string, fallback: string[]): string[] => {
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch { /* ignore */ }
  return [...fallback];
};

const SecretInput: React.FC<{
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean;
}> = ({ label, value, onChange, placeholder, required }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="form-group">
      <label className="form-label">
        {label} {required && <span style={{ color: 'var(--error)' }}>*</span>}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          className="input-text"
          style={{ paddingRight: '2.5rem' }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          style={{
            position: 'absolute', right: '0.625rem', top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
            padding: '0.25rem', display: 'flex', alignItems: 'center',
          }}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
};

/** Generic add/remove chip list (shared by Publisher IDs and Email recipients) */
const ManagedList: React.FC<{
  items: string[];
  onChange: (items: string[]) => void;
  defaults: string[];
  placeholder: string;
  validate?: (v: string) => string | null;
  collapsedCount?: number;
}> = ({ items, onChange, defaults, placeholder, validate, collapsedCount = 12 }) => {
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState(false);

  const add = () => {
    const values = input.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
    if (!values.length) return;
    for (const v of values) {
      const msg = validate?.(v);
      if (msg) { setErr(msg); return; }
    }
    const merged = [...items];
    for (const v of values) if (!merged.includes(v)) merged.push(v);
    onChange(merged);
    setInput('');
    setErr('');
  };

  const shown = expanded ? items : items.slice(0, collapsedCount);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          className="input-text"
          style={{ flex: 1 }}
          placeholder={placeholder}
          value={input}
          onChange={(e) => { setInput(e.target.value); setErr(''); }}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <button type="button" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }} onClick={add}>
          <Plus size={14} /> Add
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          title="Reset to default list"
          style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}
          onClick={() => onChange([...defaults])}
        >
          <RotateCcw size={14} /> Reset
        </button>
      </div>
      {err && <p style={{ fontSize: '0.75rem', color: 'var(--error)' }}>{err}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
        {shown.map((item) => (
          <span
            key={item}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
              background: 'var(--primary-subtle, #e8f1fb)', border: '1px solid #c7ddf5',
              borderRadius: '999px', padding: '0.2rem 0.375rem 0.2rem 0.625rem',
              fontSize: '0.75rem', fontFamily: 'monospace',
            }}
          >
            {item}
            <button
              type="button"
              onClick={() => onChange(items.filter((i) => i !== item))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-muted)', padding: 0 }}
              title={`Remove ${item}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {items.length > collapsedCount && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '0.2rem 0.625rem', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <><ChevronUp size={12} /> Collapse</> : <><ChevronDown size={12} /> Show all {items.length}</>}
          </button>
        )}
      </div>
    </div>
  );
};

const DetailTable: React.FC<{ rows: DiscrepancyRow[]; highlight?: boolean }> = ({ rows, highlight }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ background: 'var(--primary)', color: 'white', textAlign: 'left' }}>
          {['Publisher ID', 'Publisher', 'DSP', 'PM Spend', 'DSP Spend', 'Spend Disc.', 'PM Imps', 'DSP Imps', 'Imps Disc.'].map((h) => (
            <th key={h} style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ background: highlight ? '#fff3cd' : i % 2 ? '#f8fafc' : 'white', borderBottom: '1px solid #e5e7eb' }}>
            <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace' }}>{r.publisherId}</td>
            <td style={{ padding: '0.5rem 0.75rem' }}>{r.publisherName ?? 'N/A'}</td>
            <td style={{ padding: '0.5rem 0.75rem' }}>{r.dsp}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtNum(r.pubmaticSpend)}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtNum(r.dspSpend)}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 600, color: r.spendDiscrepancyPct !== null && Math.abs(r.spendDiscrepancyPct) > DISCREPANCY_CONFIG.highlightThreshold ? 'var(--error)' : 'inherit' }}>
              {fmtPct(r.spendDiscrepancyPct)}
            </td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtNum(r.pubmaticImps)}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtNum(r.dspImps)}</td>
            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtPct(r.discrepancyRate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const DiscrepancyCheckin: React.FC = () => {
  // ── tokens (pasted manually, never persisted) ──
  const [pubtoken, setPubtoken] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [cookie, setCookie] = useState('');

  // ── publisher list (built-in defaults, add/remove, persisted to localStorage) ──
  const [publisherIds, setPublisherIdsState] = useState<string[]>(() => loadList(PUB_LIST_KEY, DEFAULT_PUBLISHER_IDS));
  const setPublisherIds = (ids: string[]) => {
    setPublisherIdsState(ids);
    localStorage.setItem(PUB_LIST_KEY, JSON.stringify(ids));
  };

  // ── email recipients (built-in defaults, add/remove, persisted to localStorage) ──
  const [recipients, setRecipientsState] = useState<string[]>(() => loadList(RECIPIENTS_KEY, DEFAULT_EMAIL_RECIPIENTS));
  const setRecipients = (list: string[]) => {
    setRecipientsState(list);
    localStorage.setItem(RECIPIENTS_KEY, JSON.stringify(list));
  };

  // ── run params / state ──
  const [reportDate, setReportDate] = useState(getLatestAvailableDate());
  const [runState, setRunState] = useState<RunState>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [fetchErrors, setFetchErrors] = useState<{ publisherId: string; error: string }[]>([]);
  const [error, setError] = useState('');

  // ── run log ──
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logExpanded, setLogExpanded] = useState(true);
  const addLog = (level: LogEntry['level'], msg: string) =>
    setLogs((prev) => [...prev, { ts: new Date().toLocaleTimeString('en-GB'), level, msg }]);

  // ── results ──
  const [rows, setRows] = useState<DiscrepancyRow[]>([]);
  const [summaryText, setSummaryText] = useState('');

  // ── sending ──
  const [slackChannel, setSlackChannel] = useState('#gck-discrepancy-checkin');
  const [sendSettings, setSendSettingsState] = useState<AppSendSettings>(() => {
    try {
      const saved = localStorage.getItem(SEND_SETTINGS_KEY);
      if (saved) return { ...DEFAULT_SEND_SETTINGS, ...JSON.parse(saved) };
    } catch { /* ignore */ }
    return { ...DEFAULT_SEND_SETTINGS };
  });
  const patchSendSettings = (patch: Partial<AppSendSettings>) =>
    setSendSettingsState((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(SEND_SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  const [settingsExpanded, setSettingsExpanded] = useState(() => isTauri() && !localStorage.getItem(SEND_SETTINGS_KEY));
  const [sendConfig, setSendConfig] = useState<SendConfigStatus>({ emailEmbedded: false, slackEmbedded: false });
  const [emailStatus, setEmailStatus] = useState('');
  const [slackStatus, setSlackStatus] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    // Seed localStorage with defaults on first mount so later add/remove has a baseline
    if (!localStorage.getItem(PUB_LIST_KEY)) localStorage.setItem(PUB_LIST_KEY, JSON.stringify(publisherIds));
    if (!localStorage.getItem(RECIPIENTS_KEY)) localStorage.setItem(RECIPIENTS_KEY, JSON.stringify(recipients));
    // Ask the Rust side which credentials were embedded at build time
    if (isTauri()) getSendConfig().then(setSendConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dspSummary = useMemo(() => aggregateByDsp(rows), [rows]);
  const topSpenders = useMemo(() => getTopSpenders(rows), [rows]);
  const highlights = useMemo(() => getHighlights(rows), [rows]);

  /** Optional: bulk import from Excel (replaces the whole list) */
  const handleExcelUpload = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
      const col = data.length
        ? Object.keys(data[0]).find((c) => ['publisherid', 'publisher id', 'publisher_id'].includes(c.trim().toLowerCase()))
        : undefined;
      if (!col) {
        setError(`Could not find a Publisher ID column in ${file.name} (accepted names: PublisherID / Publisher ID / publisher_id)`);
        return;
      }
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const row of data) {
        const raw = row[col];
        if (raw === null || raw === undefined || raw === '') continue;
        const id = String(raw).trim().replace(/\.0$/, '');
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
      setPublisherIds(ids);
      setError('');
    } catch (err) {
      setError(`Failed to parse Excel: ${(err as Error).message}`);
    }
  };

  const handleRun = async () => {
    setError('');
    setFetchErrors([]);
    setEmailStatus('');
    setSlackStatus('');
    setRows([]);
    setSummaryText('');
    setLogs([]);
    setLogExpanded(true);
    setRunState('fetching');
    setProgress({ current: 0, total: publisherIds.length });

    const tokens: DiscrepancyTokens = { pubtoken: pubtoken.trim(), bearerToken: bearerToken.trim(), cookie: cookie.trim() || undefined };
    addLog('info', `Run started — report date ${reportDate}, ${publisherIds.length} publishers, threshold ±${(DISCREPANCY_CONFIG.highlightThreshold * 100).toFixed(0)}%`);

    try {
      const { rows: fetched, errors } = await fetchAllPublishers(
        publisherIds, reportDate, reportDate, tokens,
        (p) => setProgress({ current: p.current, total: p.total }),
        addLog
      );
      setFetchErrors(errors);
      addLog(
        errors.length ? 'warn' : 'info',
        `Fetch finished: ${publisherIds.length - errors.length}/${publisherIds.length} publishers OK, ${errors.length} failed, ${fetched.length} raw rows`
      );

      if (!fetched.length) {
        const commonHint = errors.length ? diagnoseError(errors[0].error) : '';
        const msg = isTauri()
          ? 'No data returned. Check: 1) token validity  2) publisher IDs  3) network / VPN connectivity'
          : 'No data returned. Check: 1) token validity  2) publisher IDs  3) the proxy server is running (npm run proxy)';
        setError(msg);
        addLog('error', `Run aborted — no data returned from any publisher.${commonHint ? `\n           ↳ Probable cause: ${commonHint}` : ''}`);
        setRunState('error');
        return;
      }

      const filtered = filterLowSpendRows(fetched);
      setRows(filtered);
      setSummaryText(generateStructuredSummary(filtered, reportDate));
      const hl = getHighlights(filtered);
      addLog('info', `Report complete: ${filtered.length} rows after low-spend filter, ${hl.length} highlighted combo(s)`);
      setRunState('done');
    } catch (err) {
      const msg = (err as Error).message;
      const hint = diagnoseError(msg);
      setError(msg);
      addLog('error', `Run failed: ${msg}${hint ? `\n           ↳ Probable cause: ${hint}` : ''}`);
      setRunState('error');
    }
  };

  const handleDownloadLog = () => {
    const text = logs.map((l) => `[${l.ts}] ${l.level.toUpperCase().padEnd(5)} ${l.msg}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `discrepancy_run_log_${reportDate}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleDownloadCsv = () => {
    const blob = new Blob([rowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pubmatic_discrepancy_${reportDate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /** Sends the report to Email AND Slack in one click. Failures are independent —
      one channel failing doesn't block the other; each outcome is logged. */
  const handleSendReport = async () => {
    setSending(true);
    setEmailStatus('');
    setSlackStatus('');

    // Email
    const html = buildEmailHtml(rows, summaryText, reportDate, dspSummary, topSpenders, highlights);
    const emailRes = await sendEmail({
      subject: buildEmailSubject(reportDate, highlights.length),
      html,
      csv: rowsToCsv(rows),
      filename: `pubmatic_discrepancy_${reportDate}.csv`,
      recipients,
    }, sendSettings);
    if (emailRes.ok) {
      setEmailStatus(`✅ Sent to ${emailRes.recipients?.join(', ')}`);
      addLog('info', `Email sent to ${emailRes.recipients?.join(', ')}`);
    } else {
      setEmailStatus(`❌ ${emailRes.error}`);
      const hint = diagnoseError(emailRes.error ?? '');
      addLog('error', `Email failed: ${emailRes.error}${hint ? `\n           ↳ Probable cause: ${hint}` : ''}`);
    }

    // Slack
    const blocks = buildSlackBlocks(rows, summaryText, reportDate, dspSummary, topSpenders, highlights);
    const slackRes = await sendSlack({
      blocks,
      text: `PubMatic Discrepancy Report — ${reportDate}`,
      channel: slackChannel.trim() || undefined,
    }, sendSettings);
    if (slackRes.ok) {
      setSlackStatus(`✅ Posted to ${slackChannel}`);
      addLog('info', `Slack message posted to ${slackChannel}`);
    } else {
      setSlackStatus(`❌ ${slackRes.error}`);
      const hint = diagnoseError(slackRes.error ?? '');
      addLog('error', `Slack failed: ${slackRes.error}${hint ? `\n           ↳ Probable cause: ${hint}` : ''}`);
    }

    setSending(false);
  };

  const isRunning = runState === 'fetching' || runState === 'analyzing';
  const canRun = !isRunning && pubtoken.trim() && bearerToken.trim() && publisherIds.length > 0;

  return (
    <div className="ap-shooter-scope">
      <div className="page-header">
        <h1>Discrepancy Check-in</h1>
        <p>Daily DSP Discrepancy report: fetch → analyze → Email / Slack. Replaces manually running daily_report.py</p>
      </div>

      {/* ── configuration ── */}
      <div className="grid-2">
        <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>1. API Credentials & Date</h2>
          <SecretInput label="Pubtoken" value={pubtoken} onChange={setPubtoken} placeholder="PUBMATIC_PUBTOKEN" required />
          <SecretInput label="Bearer Token" value={bearerToken} onChange={setBearerToken} placeholder="PUBMATIC_BEARER_TOKEN (generate in Token Management)" required />
          <SecretInput label="Cookie" value={cookie} onChange={setCookie} placeholder="Optional: session cookie" />
          <div className="form-group">
            <label className="form-label">Report date (data latency T-{DISCREPANCY_CONFIG.dataLatencyDays}, defaults to latest available)</label>
            <input type="date" className="input-text" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Tokens are kept in page memory only and cleared on refresh. Bearer tokens can be generated/refreshed on the Token Management page.
            {isTauri()
              ? ' Desktop app mode: requests are sent directly — no proxy server needed.'
              : ' Dev mode: requires the local proxy (npm run proxy).'}
          </p>
          <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }} onClick={handleRun} disabled={!canRun}>
            {isRunning ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {runState === 'fetching' ? `Fetching ${progress.current}/${progress.total}...` : 'Run Report'}
          </button>
          {isRunning && progress.total > 0 && (
            <div style={{ background: '#e5e7eb', borderRadius: '999px', height: '8px', overflow: 'hidden' }}>
              <div style={{ background: 'var(--primary)', height: '100%', width: `${(progress.current / progress.total) * 100}%`, transition: 'width 0.3s' }} />
            </div>
          )}
        </div>

        <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>2. Publisher List ({publisherIds.length})</h2>
            <label className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', cursor: 'pointer', padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}>
              <Upload size={14} /> Bulk replace from Excel
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files?.[0]) { handleExcelUpload(e.target.files[0]); e.target.value = ''; } }}
              />
            </label>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
            The default list is built in (from GCK_Publisherlist_Monetizing.xlsx) — no upload needed. Add new publishers below when they come up; changes are saved automatically.
          </p>
          <ManagedList
            items={publisherIds}
            onChange={setPublisherIds}
            defaults={DEFAULT_PUBLISHER_IDS}
            placeholder="Enter Publisher ID (comma/space separated for bulk add)"
            validate={(v) => (/^\d+$/.test(v) ? null : `"${v}" is not a valid Publisher ID (digits only)`)}
          />
        </div>
      </div>

      {/* ── email recipients management ── */}
      <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>3. Email Recipients ({recipients.length})</h2>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
          Defaults to the gck-discrepancy-checkin recipient list. Add or remove as needed; changes are saved automatically.
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

      {/* ── sending settings (desktop app only; hidden entirely when credentials
             are embedded in the build via src-tauri/.build-secrets.env) ── */}
      {isTauri() && !(sendConfig.emailEmbedded && sendConfig.slackEmbedded) && (
        <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Settings size={18} /> 4. Sending Settings
              {(sendConfig.emailEmbedded || (sendSettings.emailUser && sendSettings.emailPassword))
                ? <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'white', background: 'var(--success)', borderRadius: '999px', padding: '0.1rem 0.5rem' }}>{sendConfig.emailEmbedded ? 'Email: managed' : 'Email configured'}</span>
                : <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'white', background: 'var(--warning)', borderRadius: '999px', padding: '0.1rem 0.5rem' }}>Email not configured</span>}
              {(sendConfig.slackEmbedded || sendSettings.slackBotToken)
                ? <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'white', background: 'var(--success)', borderRadius: '999px', padding: '0.1rem 0.5rem' }}>{sendConfig.slackEmbedded ? 'Slack: managed' : 'Slack configured'}</span>
                : <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'white', background: 'var(--warning)', borderRadius: '999px', padding: '0.1rem 0.5rem' }}>Slack not configured</span>}
            </h2>
            <button className="btn btn-secondary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }} onClick={() => setSettingsExpanded(!settingsExpanded)}>
              {settingsExpanded ? <><ChevronUp size={13} /> Collapse</> : <><ChevronDown size={13} /> Configure</>}
            </button>
          </div>
          {settingsExpanded && (
            <>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                The desktop app sends Email/Slack directly — configure once here. Values are stored only on this computer and never leave it except to the SMTP/Slack servers. Prefer an app-specific password if available.
              </p>
              {!sendConfig.emailEmbedded && (
                <>
                  <div className="grid-2">
                    <div className="form-group">
                      <label className="form-label">SMTP Host</label>
                      <input type="text" className="input-text" value={sendSettings.smtpHost} onChange={(e) => patchSendSettings({ smtpHost: e.target.value })} placeholder="smtp.office365.com" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">SMTP Port</label>
                      <input type="number" className="input-text" value={sendSettings.smtpPort} onChange={(e) => patchSendSettings({ smtpPort: parseInt(e.target.value, 10) || 587 })} placeholder="587" />
                    </div>
                  </div>
                  <div className="grid-2">
                    <div className="form-group">
                      <label className="form-label">Sender Email (SMTP user)</label>
                      <input type="email" className="input-text" value={sendSettings.emailUser} onChange={(e) => patchSendSettings({ emailUser: e.target.value })} placeholder="your.name@pubmatic.com" />
                    </div>
                    <SecretInput
                      label="Email Password"
                      value={sendSettings.emailPassword}
                      onChange={(v) => patchSendSettings({ emailPassword: v })}
                      placeholder="SMTP / app-specific password"
                    />
                  </div>
                </>
              )}
              {!sendConfig.slackEmbedded && (
                <SecretInput
                  label="Slack Bot Token"
                  value={sendSettings.slackBotToken}
                  onChange={(v) => patchSendSettings({ slackBotToken: v })}
                  placeholder="xoxb-..."
                />
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <div className="glass-card" style={{ borderLeft: '4px solid var(--error)', color: 'var(--error)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      {fetchErrors.length > 0 && (
        <div className="glass-card" style={{ borderLeft: '4px solid var(--warning)', fontSize: '0.8125rem' }}>
          <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>⚠️ {fetchErrors.length} publisher(s) failed to fetch:</p>
          {fetchErrors.slice(0, 10).map((e) => (
            <p key={e.publisherId} style={{ color: 'var(--text-secondary)' }}>• {e.publisherId}: {e.error.slice(0, 150)}</p>
          ))}
          {fetchErrors.length > 10 && <p>...and {fetchErrors.length - 10} more</p>}
        </div>
      )}

      {/* ── run log ── */}
      {logs.length > 0 && (
        <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Terminal size={18} /> Run Log ({logs.length})
              {logs.some((l) => l.level === 'error') && (
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'white', background: 'var(--error)', borderRadius: '999px', padding: '0.1rem 0.5rem' }}>
                  {logs.filter((l) => l.level === 'error').length} error(s)
                </span>
              )}
            </h2>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-secondary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }} onClick={handleDownloadLog}>
                <Download size={13} /> Download log
              </button>
              <button className="btn btn-secondary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }} onClick={() => setLogExpanded(!logExpanded)}>
                {logExpanded ? <><ChevronUp size={13} /> Collapse</> : <><ChevronDown size={13} /> Expand</>}
              </button>
            </div>
          </div>
          {logExpanded && (
            <div style={{
              background: '#0f172a', borderRadius: '0.5rem', padding: '0.75rem 1rem',
              maxHeight: '320px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.75rem', lineHeight: 1.7,
            }}>
              {logs.map((l, i) => (
                <div key={i} style={{ whiteSpace: 'pre-wrap', color: LOG_COLORS[l.level] }}>
                  <span style={{ color: '#64748b' }}>[{l.ts}]</span>{' '}
                  <span style={{ fontWeight: l.level === 'error' ? 700 : 400 }}>{l.level.toUpperCase().padEnd(5)}</span>{' '}
                  {l.msg}
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
                {highlights.length ? <AlertTriangle size={22} style={{ color: 'var(--warning)' }} /> : <CheckCircle2 size={22} style={{ color: 'var(--success)' }} />}
                <h2 style={{ fontSize: '1.15rem', fontWeight: 600 }}>
                  {reportDate} — {highlights.length ? `${highlights.length} highlighted combos` : 'All Clear'}
                </h2>
              </div>
              <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={handleDownloadCsv}>
                <Download size={16} /> Download CSV
              </button>
            </div>
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              <span>Publishers: <b>{new Set(rows.map((r) => r.publisherId)).size}</b></span>
              <span>DSPs: <b>{new Set(rows.map((r) => r.dsp)).size}</b></span>
              <span>Rows: <b>{rows.length}</b></span>
              <span>Threshold: <b>±{(DISCREPANCY_CONFIG.highlightThreshold * 100).toFixed(0)}%</b></span>
            </div>

            <div style={{ background: 'var(--bg-subtle, #f5f5f5)', borderLeft: '4px solid var(--primary)', padding: '1rem', borderRadius: '0 0.5rem 0.5rem 0' }}>
              <p style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                📝 Summary
              </p>
              <p style={{ fontSize: '0.875rem', whiteSpace: 'pre-line', lineHeight: 1.7 }}>{summaryText}</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <label className="form-label">Slack Channel</label>
                  <input type="text" className="input-text" value={slackChannel} onChange={(e) => setSlackChannel(e.target.value)} />
                </div>
                <button
                  className="btn btn-primary"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap', padding: '0.625rem 1.5rem' }}
                  onClick={handleSendReport}
                  disabled={sending || !recipients.length}
                >
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  {sending ? 'Sending...' : 'Send Report'}
                </button>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                Sends the email (with CSV attachment) to the {recipients.length} recipients in section 3 and posts to Slack in one click.
              </p>
              {emailStatus && <p style={{ fontSize: '0.8125rem' }}>Email: {emailStatus}</p>}
              {slackStatus && <p style={{ fontSize: '0.8125rem' }}>Slack: {slackStatus}</p>}
            </div>
          </div>

          {/* Section 1 */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>📊 Section 1 — Overall DSP Summary (All Publishers Combined)</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--primary)', color: 'white', textAlign: 'left' }}>
                    {['DSP', 'Publishers', 'Rows', 'PM Spend', 'DSP Spend', 'Spend Disc.', 'PM Imps', 'DSP Imps', 'Imps Disc.'].map((h) => (
                      <th key={h} style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dspSummary.map((r, i) => (
                    <tr key={r.dsp} style={{ background: i % 2 ? '#f8fafc' : 'white', borderBottom: '1px solid #e5e7eb' }}>
                      <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>{r.dsp}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{r.publishers}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{r.rows}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtNum(r.pubmaticSpend)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtNum(r.dspSpend)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 600, color: r.spendDiscrepancyPct !== null && Math.abs(r.spendDiscrepancyPct) > DISCREPANCY_CONFIG.highlightThreshold ? 'var(--error)' : 'inherit' }}>
                        {fmtPct(r.spendDiscrepancyPct)}
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtNum(r.pubmaticImps)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtNum(r.dspImps)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{fmtPct(r.discrepancyRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 2 */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>📋 Section 2 — Top 20 Spenders by DSP Partner Spend</h2>
            <DetailTable rows={topSpenders} />
          </div>

          {/* Section 3 */}
          <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600, color: highlights.length ? 'var(--error)' : 'inherit' }}>
              ⚠️ Section 3 — Highlighted Publisher / DSP (exceeding ±{(DISCREPANCY_CONFIG.highlightThreshold * 100).toFixed(0)}%)
            </h2>
            {highlights.length
              ? <DetailTable rows={highlights} highlight />
              : <p style={{ fontSize: '0.875rem', color: 'var(--success)' }}>✅ No publisher/DSP combinations exceed the threshold.</p>}
          </div>
        </>
      )}
    </div>
  );
};

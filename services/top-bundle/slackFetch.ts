// ─────────────────────────────────────────────
// Auto-fetch the latest Looker CSV that was delivered to a Slack channel.
//
// Looker's "Slack Attachment (API Token)" schedule posts a CSV file to a channel
// daily. This finds the newest matching CSV and downloads it.
//
// Dual-path (same pattern as email):
//   - Dev/browser: GET the local server /api/slack/looker-latest (bot token in server/.env).
//   - Desktop (Tauri): call Slack Web API directly via native_fetch, using the
//     Slack token from Discrepancy → Sending Settings (stored only on this computer).
//
// Requires the bot to be IN the channel and to have the files:read scope
// (private channels also need groups:history).
// ─────────────────────────────────────────────
import { PROXY_BASE } from '@/services/discrepancy/apiService';
import { isTauri, lookerFetch, getLookerConfig } from '@/services/discrepancy/nativeBridge';

/** Desktop: resolve the Looker channel (from the arg, else the embedded build config). */
async function tauriChannel(channel: string): Promise<string> {
  const c = channel.trim();
  if (c) return c;
  return (await getLookerConfig()).channel;
}

interface SlackFile {
  id?: string;
  name?: string;
  filetype?: string;
  created?: number;
  url_private_download?: string;
  url_private?: string;
}

const isTsv = (f: SlackFile): boolean =>
  f.filetype === 'tsv' || /\.(tsv|tab)$/.test((f.name || '').toLowerCase());

/** Newest Looker TSV export in the channel. TSV only — the dated TSV is the source
    of truth; the same-name CSV (no date, row-capped) is intentionally ignored. */
function pickLatestExport(files: SlackFile[], match: string): SlackFile | null {
  const m = match.trim().toLowerCase();
  const data = files.filter((f) => isTsv(f) && (!m || (f.name || '').toLowerCase().includes(m)));
  data.sort((a, b) => (b.created || 0) - (a.created || 0));   // newest first
  return data[0] ?? null;
}

export interface SlackFetchResult { filename: string; text: string; fileId?: string; }

/** Lightweight metadata about the file that WOULD be fetched — no download. Used to
    check the Slack file id before re-downloading a huge file we already processed. */
export interface SlackPeek { fileId?: string; filename: string; date: string; }

export async function fetchLatestFromSlack(
  channel: string, match: string, slackToken?: string,
): Promise<SlackFetchResult> {
  // Dev/browser: channel/token come from server/.env (LOOKER_SLACK_CHANNEL / _BOT_TOKEN),
  // so an empty channel here is fine. Desktop (Tauri) needs both passed in.
  if (isTauri()) {
    const ch = await tauriChannel(channel);
    if (!ch) throw new Error('Looker Slack channel not configured (embed EMBED_LOOKER_SLACK_CHANNEL at build time).');
    const listRes = await lookerFetch(`https://slack.com/api/files.list?channel=${encodeURIComponent(ch)}&count=100`);
    if (!listRes.ok) throw new Error(`Slack files.list HTTP ${listRes.status}`);
    const list = JSON.parse(listRes.text);
    if (!list.ok) throw new Error(`Slack files.list: ${list.error}`);
    const file = pickLatestExport(list.files || [], match);
    if (!file) throw new Error('No matching CSV/TSV file found in that channel.');
    const dl = await lookerFetch(file.url_private_download || file.url_private || '');
    if (!dl.ok) throw new Error(`Download failed HTTP ${dl.status}`);
    return { filename: file.name || 'looker.csv', text: dl.text, fileId: file.id };
  }

  const resp = await fetch(
    `${PROXY_BASE}/api/slack/looker-latest?channel=${encodeURIComponent(channel)}&match=${encodeURIComponent(match)}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Slack fetch failed');
  return { filename: data.filename || 'looker.csv', text: data.csv || '', fileId: data.fileId };
}

/** Peek the newest matching TSV's id/name WITHOUT downloading it (files.list only). */
export async function peekLatestFromSlack(
  channel: string, match: string, slackToken?: string,
): Promise<SlackPeek | null> {
  if (isTauri()) {
    const ch = await tauriChannel(channel);
    if (!ch) return null;
    const listRes = await lookerFetch(`https://slack.com/api/files.list?channel=${encodeURIComponent(ch)}&count=100`);
    if (!listRes.ok) return null;
    const list = JSON.parse(listRes.text);
    if (!list.ok) return null;
    const file = pickLatestExport(list.files || [], match);
    return file ? { fileId: file.id, filename: file.name || '', date: filenameDate(file.name) } : null;
  }
  const resp = await fetch(
    `${PROXY_BASE}/api/slack/looker-latest?channel=${encodeURIComponent(channel)}&match=${encodeURIComponent(match)}&meta=1`);
  const data = await resp.json();
  if (!data.ok) return null;
  return { fileId: data.fileId, filename: data.filename || '', date: filenameDate(data.filename) };
}

/** Filename substrings for a given ISO date (Looker names its files by date, but the
    exact separator varies) — used to locate a specific day's export. */
function dateVariants(iso: string): string[] {
  const [y, mo, da] = iso.split('-');
  if (!y || !mo || !da) return [iso];
  return [`${y}-${mo}-${da}`, `${y}_${mo}_${da}`, `${y}${mo}${da}`, `${y}.${mo}.${da}`, `${y}/${mo}/${da}`];
}

/** Fetch the Looker export for a SPECIFIC date (by matching the date in the filename).
    Returns null when no file for that date is present. Throws on transport/config errors. */
export async function fetchFromSlackByDate(
  isoDate: string, channel = '', match = '', slackToken?: string,
): Promise<SlackFetchResult | null> {
  const variants = dateVariants(isoDate);
  const nameHasDate = (name: string) => {
    const n = name.toLowerCase();
    return variants.some((v) => n.includes(v.toLowerCase()));
  };

  if (isTauri()) {
    const ch = await tauriChannel(channel);
    if (!ch) throw new Error('Looker Slack channel not configured (embed EMBED_LOOKER_SLACK_CHANNEL at build time).');
    const listRes = await lookerFetch(`https://slack.com/api/files.list?channel=${encodeURIComponent(ch)}&count=100`);
    if (!listRes.ok) throw new Error(`Slack files.list HTTP ${listRes.status}`);
    const list = JSON.parse(listRes.text);
    if (!list.ok) throw new Error(`Slack files.list: ${list.error}`);
    const m = match.trim().toLowerCase();
    const dated = (list.files || []).filter((f: SlackFile) =>
      isTsv(f) && nameHasDate(f.name || '') && (!m || (f.name || '').toLowerCase().includes(m)));
    dated.sort((a: SlackFile, b: SlackFile) => (b.created || 0) - (a.created || 0));   // newest first
    const file = dated[0];
    if (!file) return null;
    const dl = await lookerFetch(file.url_private_download || file.url_private || '');
    if (!dl.ok) throw new Error(`Download failed HTTP ${dl.status}`);
    return { filename: file.name || 'looker.csv', text: dl.text };
  }

  const resp = await fetch(
    `${PROXY_BASE}/api/slack/looker-latest?channel=${encodeURIComponent(channel)}&match=${encodeURIComponent(match)}&date=${encodeURIComponent(isoDate)}`);
  const data = await resp.json();
  if (!data.ok) {
    if (/no (matching|file|tsv)/i.test(data.error || '')) return null;   // simply not present for that date
    throw new Error(data.error || 'Slack fetch failed');
  }
  return { filename: data.filename || 'looker.csv', text: data.csv || '' };
}

/** Parse the YYYY-MM-DD date out of a Looker filename (e.g. bundle_performance_20260810.tsv). */
export function filenameDate(name?: string): string {
  const m = String(name || '').match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

export interface SlackPriorResult extends SlackFetchResult { date: string; }

/** Fetch the MOST RECENT prior day's export strictly before `beforeIso` (by filename
    date) — auto-skips weekends / holidays / any gap.
    Returns null when no earlier file exists. Throws on transport/config errors. */
export async function fetchPriorFromSlack(
  beforeIso: string, channel = '', match = '', slackToken?: string,
): Promise<SlackPriorResult | null> {
  if (isTauri()) {
    const ch = await tauriChannel(channel);
    if (!ch) throw new Error('Looker Slack channel not configured (embed EMBED_LOOKER_SLACK_CHANNEL at build time).');
    const listRes = await lookerFetch(`https://slack.com/api/files.list?channel=${encodeURIComponent(ch)}&count=100`);
    if (!listRes.ok) throw new Error(`Slack files.list HTTP ${listRes.status}`);
    const list = JSON.parse(listRes.text);
    if (!list.ok) throw new Error(`Slack files.list: ${list.error}`);
    const m = match.trim().toLowerCase();
    const dated = (list.files || [])
      .filter((f: SlackFile) => isTsv(f) && (!m || (f.name || '').toLowerCase().includes(m)))
      .map((f: SlackFile) => ({ f, d: filenameDate(f.name) }))
      .filter((x: { f: SlackFile; d: string }) => x.d && x.d < beforeIso)
      .sort((a: { f: SlackFile; d: string }, b: { f: SlackFile; d: string }) =>
        (a.d < b.d ? 1 : a.d > b.d ? -1 : (b.f.created || 0) - (a.f.created || 0)));
    const top = dated[0];
    if (!top) return null;
    const dl = await lookerFetch(top.f.url_private_download || top.f.url_private || '');
    if (!dl.ok) throw new Error(`Download failed HTTP ${dl.status}`);
    return { filename: top.f.name || 'looker.tsv', text: dl.text, date: top.d, fileId: top.f.id };
  }

  const resp = await fetch(
    `${PROXY_BASE}/api/slack/looker-latest?channel=${encodeURIComponent(channel)}&match=${encodeURIComponent(match)}&before=${encodeURIComponent(beforeIso)}`);
  const data = await resp.json();
  if (!data.ok) {
    if (/no (matching|file|tsv)/i.test(data.error || '')) return null;   // no earlier day present
    throw new Error(data.error || 'Slack fetch failed');
  }
  return { filename: data.filename || 'looker.tsv', text: data.csv || '', date: filenameDate(data.filename), fileId: data.fileId };
}

/** Peek the most-recent prior day's file id/name/date strictly before `beforeIso`,
    WITHOUT downloading it — so the caller can reuse a cached baseline when unchanged. */
export async function peekPriorFromSlack(
  beforeIso: string, channel = '', match = '', slackToken?: string,
): Promise<SlackPeek | null> {
  if (isTauri()) {
    const ch = await tauriChannel(channel);
    if (!ch) return null;
    const listRes = await lookerFetch(`https://slack.com/api/files.list?channel=${encodeURIComponent(ch)}&count=100`);
    if (!listRes.ok) return null;
    const list = JSON.parse(listRes.text);
    if (!list.ok) return null;
    const m = match.trim().toLowerCase();
    const dated = (list.files || [])
      .filter((f: SlackFile) => isTsv(f) && (!m || (f.name || '').toLowerCase().includes(m)))
      .map((f: SlackFile) => ({ f, d: filenameDate(f.name) }))
      .filter((x: { f: SlackFile; d: string }) => x.d && x.d < beforeIso)
      .sort((a: { f: SlackFile; d: string }, b: { f: SlackFile; d: string }) =>
        (a.d < b.d ? 1 : a.d > b.d ? -1 : (b.f.created || 0) - (a.f.created || 0)));
    const top = dated[0];
    return top ? { fileId: top.f.id, filename: top.f.name || '', date: top.d } : null;
  }
  const resp = await fetch(
    `${PROXY_BASE}/api/slack/looker-latest?channel=${encodeURIComponent(channel)}&match=${encodeURIComponent(match)}&before=${encodeURIComponent(beforeIso)}&meta=1`);
  const data = await resp.json();
  if (!data.ok) return null;
  return { fileId: data.fileId, filename: data.filename || '', date: filenameDate(data.filename) };
}

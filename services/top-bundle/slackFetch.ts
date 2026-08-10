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
import { isTauri, nativeFetch } from '@/services/discrepancy/nativeBridge';

interface SlackFile {
  name?: string;
  filetype?: string;
  created?: number;
  url_private_download?: string;
  url_private?: string;
}

const isTsv = (f: SlackFile): boolean =>
  f.filetype === 'tsv' || /\.(tsv|tab)$/.test((f.name || '').toLowerCase());
const isCsv = (f: SlackFile): boolean =>
  f.filetype === 'csv' || (f.name || '').toLowerCase().endsWith('.csv');

/** Newest Looker data file in the channel. Accepts CSV and TSV; prefers TSV, which
    the newer schedule uses because it isn't subject to the CSV row cap. */
function pickLatestExport(files: SlackFile[], match: string): SlackFile | null {
  const m = match.trim().toLowerCase();
  const data = files.filter((f) =>
    (isTsv(f) || isCsv(f)) && (!m || (f.name || '').toLowerCase().includes(m)));
  // TSV first (more complete), then newest by created time.
  data.sort((a, b) => (isTsv(b) ? 1 : 0) - (isTsv(a) ? 1 : 0) || (b.created || 0) - (a.created || 0));
  return data[0] ?? null;
}

export interface SlackFetchResult { filename: string; text: string; }

export async function fetchLatestFromSlack(
  channel: string, match: string, slackToken?: string,
): Promise<SlackFetchResult> {
  // Dev/browser: channel/token come from server/.env (LOOKER_SLACK_CHANNEL / _BOT_TOKEN),
  // so an empty channel here is fine. Desktop (Tauri) needs both passed in.
  if (isTauri()) {
    if (!slackToken) throw new Error('Slack token not set — configure LOOKER_SLACK_BOT_TOKEN (desktop build).');
    if (!channel.trim()) throw new Error('Slack channel not set for the desktop app.');
    const auth = { Authorization: `Bearer ${slackToken}` };
    const listRes = await nativeFetch(
      `https://slack.com/api/files.list?channel=${encodeURIComponent(channel)}&count=100`, { headers: auth });
    if (!listRes.ok) throw new Error(`Slack files.list HTTP ${listRes.status}`);
    const list = JSON.parse(listRes.text);
    if (!list.ok) throw new Error(`Slack files.list: ${list.error}`);
    const file = pickLatestExport(list.files || [], match);
    if (!file) throw new Error('No matching CSV/TSV file found in that channel.');
    const dl = await nativeFetch(file.url_private_download || file.url_private || '', { headers: auth });
    if (!dl.ok) throw new Error(`Download failed HTTP ${dl.status}`);
    return { filename: file.name || 'looker.csv', text: dl.text };
  }

  const resp = await fetch(
    `${PROXY_BASE}/api/slack/looker-latest?channel=${encodeURIComponent(channel)}&match=${encodeURIComponent(match)}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Slack fetch failed');
  return { filename: data.filename || 'looker.csv', text: data.csv || '' };
}

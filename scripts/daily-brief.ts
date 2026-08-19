// ─────────────────────────────────────────────
// Headless daily brief — standalone Node job (no browser, no proxy needed).
//
// Flow: fetch today's dated TSV + the most-recent-prior day's TSV directly from
// the Looker Slack channel → standardize both → compute day-over-day IN MEMORY
// (no localStorage / snapshot cache, so weekends & gaps are handled automatically)
// → build the internal email (same analysis as the app) + a Slack brief.
//
// DRY RUN by default: writes the email HTML to a file and prints the Slack text.
// Pass --send to actually email recipients and post to Slack.
//
// Run:  npm run daily-brief            (dry run)
//       npm run daily-brief -- --send  (really send)
//       npm run daily-brief -- --date=2026-08-10   (pretend "today" is this date)
//
// Secrets come from server/.env (LOOKER_SLACK_BOT_TOKEN, LOOKER_SLACK_CHANNEL,
// EMAIL_USER/EMAIL_PASSWORD, EMAIL_RECIPIENTS, SLACK_BOT_TOKEN, SLACK_CHANNEL).
// ─────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import nodemailer from 'nodemailer';

import { parseCsvText, autoMap } from '../services/top-bundle/fileParser';
import {
  standardizeMapped, computeMetrics, generateStructuredSummary,
  topBundles, topPublishers, gckPublishers, gckBundles, byDsp, dspWithBundles,
  byCountry, byRegion, byPod, byAdFormat, adFormatPivot, bundlePublisherBreakdown, partnerList,
  fmtCurrency,
} from '../services/top-bundle/dataProcessor';
import {
  diffPublishers, diffDim, diffTopN, bundleChangeMap, overallDayOverDay,
} from '../services/top-bundle/history';
import { buildEmailHtml, buildEmailSubject, partnerCsv, ReportSummaries, EmailDoD } from '../services/top-bundle/reportBuilder';
import { DEFAULT_EMAIL_RECIPIENTS } from '../services/top-bundle/defaults';
import { AggRow, BundleRow } from '../services/top-bundle/types';

// ── tiny .env parser (mirrors the server's built-in loader) ──
function loadEnv(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

// ── args ──
const args = process.argv.slice(2);
const DO_SEND = args.includes('--send');
const OPEN = args.includes('--open');
const dateArg = (args.find((a) => a.startsWith('--date=')) || '').split('=')[1] || '';

const env = loadEnv(path.resolve(process.cwd(), 'server/.env'));
const LOOKER_TOKEN = env.LOOKER_SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN || '';
const LOOKER_CHANNEL = env.LOOKER_SLACK_CHANNEL || '';
const LOOKER_MATCH = (env.LOOKER_SLACK_MATCH || '').toLowerCase();
// Post the brief with a bot that is a member of the target channel + has chat:write.
// Default order: dedicated token → discrepancy bot → the Looker bot (already in the
// Looker channel, so posting the brief back into that same channel works out of the box).
const POST_TOKEN = env.DAILY_BRIEF_SLACK_TOKEN || env.SLACK_BOT_TOKEN || env.LOOKER_SLACK_BOT_TOKEN || '';
const POST_CHANNEL = env.DAILY_BRIEF_SLACK_CHANNEL || env.SLACK_CHANNEL || '';
const recipients = (env.EMAIL_RECIPIENTS ? env.EMAIL_RECIPIENTS.split(',') : DEFAULT_EMAIL_RECIPIENTS)
  .map((r) => r.trim()).filter(Boolean);

const log = (...m: unknown[]) => console.log(...m);

// ── Slack file helpers (direct Web API; no proxy) ──
interface SlackFile { name?: string; filetype?: string; created?: number; url_private_download?: string; url_private?: string; }
const isTsv = (n?: string) => /\.(tsv|tab)$/.test(String(n || '').toLowerCase());
const fileDate = (n?: string) => { const m = String(n || '').match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
const nameOk = (f: SlackFile) => isTsv(f.name) && (!LOOKER_MATCH || String(f.name || '').toLowerCase().includes(LOOKER_MATCH));

async function filesList(): Promise<SlackFile[]> {
  const r = await fetch(`https://slack.com/api/files.list?channel=${encodeURIComponent(LOOKER_CHANNEL)}&count=100`,
    { headers: { Authorization: `Bearer ${LOOKER_TOKEN}` } });
  const j = await r.json() as { ok: boolean; error?: string; files?: SlackFile[] };
  if (!j.ok) throw new Error(`Slack files.list: ${j.error}`);
  return j.files || [];
}
async function download(f: SlackFile): Promise<string> {
  const r = await fetch(f.url_private_download || f.url_private || '', { headers: { Authorization: `Bearer ${LOOKER_TOKEN}` } });
  if (!r.ok) throw new Error(`Download HTTP ${r.status}`);
  return r.text();
}
const pickLatest = (files: SlackFile[]) => files.filter(nameOk).sort((a, b) => (b.created || 0) - (a.created || 0))[0] || null;
const pickBefore = (files: SlackFile[], before: string) =>
  files.filter(nameOk).map((f) => ({ f, d: fileDate(f.name) })).filter((x) => x.d && x.d < before)
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : (b.f.created || 0) - (a.f.created || 0)))
    .map((x) => x.f)[0] || null;

// ── standardize a fetched TSV into BundleRow[] ──
function standardize(text: string, filename: string): BundleRow[] {
  const parsed = parseCsvText(text, filename);
  if (parsed.issues) {
    const bt = Object.entries(parsed.issues.byType).map(([k, v]) => `${v}× ${k}`).join(', ');
    console.warn(`[parse] ${filename}: ${parsed.issues.count} row issue(s) [${bt}]${parsed.issues.firstRow != null ? `, first at data row ${parsed.issues.firstRow}` : ''} — rows may be dropped/misaligned.`);
  }
  return standardizeMapped(parsed.rows, autoMap(parsed.headers));
}

// ── snapshot builders (feed the pure diff functions without localStorage) ──
const pubSnaps = (rows: AggRow[]) => rows.map((p, i) => ({ publisher: String(p.publisher ?? ''), spend: p.spend, pmr: p.pmr, rank: i + 1 }));
const dimSnaps = (rows: AggRow[], key: keyof AggRow) => rows.map((r) => ({ name: String(r[key] ?? ''), spend: r.spend, pmr: r.pmr }));
const bunSnaps = (rows: AggRow[]) => rows.map((b, i) => ({ bundle: String(b.bundle ?? ''), appName: String(b.appName ?? ''), spend: b.spend, pmr: b.pmr, rank: i + 1 }));

async function main() {
  if (!LOOKER_TOKEN || !LOOKER_CHANNEL) throw new Error('LOOKER_SLACK_BOT_TOKEN / LOOKER_SLACK_CHANNEL not set in server/.env');

  log(`\n▶ Daily brief — ${DO_SEND ? 'SEND MODE' : 'DRY RUN'} (recipients: ${recipients.length}, slack: ${POST_CHANNEL || '(none)'})\n`);

  // 1. today's TSV (latest, or the one matching --date)
  const files = await filesList();
  const todayFile = dateArg
    ? files.filter(nameOk).find((f) => fileDate(f.name) === dateArg) || null
    : pickLatest(files);
  if (!todayFile) throw new Error(dateArg ? `No TSV for ${dateArg} in the channel` : 'No TSV found in the channel');
  const reportDate = fileDate(todayFile.name) || dateArg || new Date().toISOString().slice(0, 10);
  log(`  today : ${todayFile.name}  (reportDate ${reportDate})`);

  // 2. most-recent prior day (skips weekends/gaps automatically)
  const priorFile = pickBefore(files, reportDate);
  const prevDate = priorFile ? fileDate(priorFile.name) : '';
  log(`  prior : ${priorFile ? priorFile.name + `  (prevDate ${prevDate})` : '(none — baseline, no DoD)'}\n`);

  // 3. fetch + standardize
  const std = standardize(await download(todayFile), todayFile.name!);
  const prevStd = priorFile ? standardize(await download(priorFile), priorFile.name!) : [];
  log(`  rows  : today ${std.length.toLocaleString()} | prior ${prevStd.length.toLocaleString()}`);

  const m = computeMetrics(std);
  if (m.inAppPmr <= 0) log('  ⚠ in-app PMR is $0 — check the PMR column mapped correctly.');

  // 4. day-over-day (in memory)
  const has = prevDate && prevStd.length;
  const rankedToday = topBundles(std, 200);
  const bundleDod = has ? diffTopN(rankedToday, { date: prevDate, snap: bunSnaps(topBundles(prevStd, 200)) }, 50) : null;
  const changeMap = bundleChangeMap(rankedToday, has ? { snap: bunSnaps(topBundles(prevStd, 200)) } : null, 50);
  const pubDod = diffPublishers(topPublishers(std, 100), has ? { date: prevDate, snap: pubSnaps(topPublishers(prevStd, 100)) } : null, 20);
  const gckPubDod = diffPublishers(gckPublishers(std, 100), has ? { date: prevDate, snap: pubSnaps(gckPublishers(prevStd, 100)) } : null, 20);
  const gckBunDod = diffDim(gckBundles(std, 50), has ? { date: prevDate, snap: dimSnaps(gckBundles(prevStd, 50), 'appName') } : null, 'appName', 20);
  const regionDod = diffDim(byRegion(std), has ? { date: prevDate, snap: dimSnaps(byRegion(prevStd), 'region') } : null, 'region', 10);
  const podDod = diffDim(byPod(std, 30), has ? { date: prevDate, snap: dimSnaps(byPod(prevStd, 30), 'pod') } : null, 'pod', 10);
  const dspDod = diffDim(byDsp(std, 30), has ? { date: prevDate, snap: dimSnaps(byDsp(prevStd, 30), 'dsp') } : null, 'dsp', 10);
  const countryDod = diffDim(byCountry(std, 30), has ? { date: prevDate, snap: dimSnaps(byCountry(prevStd, 30), 'country') } : null, 'country', 10);
  const adFmtDod = diffDim(byAdFormat(std, 30), has ? { date: prevDate, snap: dimSnaps(byAdFormat(prevStd, 30), 'adFormat') } : null, 'adFormat', 12);
  const mPrev = has ? computeMetrics(prevStd) : null;
  const overall = has && mPrev
    ? overallDayOverDay({ inAppSpend: m.inAppSpend, pmr: m.inAppPmr, revenue: m.totalRevenue },
      { date: prevDate, totals: { inAppSpend: mPrev.inAppSpend, pmr: mPrev.inAppPmr, revenue: mPrev.totalRevenue } })
    : null;

  const dodContext = {
    overall, bundle: bundleDod, publishers: pubDod, gckPublishers: gckPubDod, gckBundles: gckBunDod,
    region: regionDod, pod: podDod, dsp: dspDod, country: countryDod, adFormat: adFmtDod,
  };
  const summaryText = generateStructuredSummary(std, reportDate, dodContext);

  // 5. build email + Slack brief
  const summaries: ReportSummaries = {
    topBundles: topBundles(std), topPublishers: topPublishers(std, 20), gckPublishers: gckPublishers(std, 20),
    byDsp: byDsp(std), dspGroups: dspWithBundles(std, 10, 5), byCountry: byCountry(std, 10),
    byRegion: byRegion(std), byPod: byPod(std), adFormatPivot: adFormatPivot(std), bundlePublisher: bundlePublisherBreakdown(std),
  };
  const emailDoD: EmailDoD = {
    overall, publishers: pubDod, gckPublishers: gckPubDod, region: regionDod, pod: podDod,
    dsp: dspDod, country: countryDod, adFormat: adFmtDod, bundleChangeMap: changeMap,
  };
  const html = buildEmailHtml(summaries, summaryText, m, reportDate, emailDoD);
  const subject = buildEmailSubject(reportDate);
  const csv = partnerCsv(partnerList(std));
  const slackText = buildSlackText(summaryText, reportDate, m, overall, recipients.length);

  // 6. send or dry-run
  if (!DO_SEND) {
    const out = path.join(os.tmpdir(), `daily-brief-${reportDate}.html`);
    fs.writeFileSync(out, html);
    log(`\n── DRY RUN ─────────────────────────────────`);
    log(`Subject : ${subject}`);
    log(`Email   : ${out}  (${(html.length / 1024).toFixed(0)} KB, CSV attach ${(csv.length / 1024).toFixed(0)} KB)`);
    log(`To      : ${recipients.join(', ')}`);
    log(`Overall : ${overall && overall.pmrDeltaPct != null ? `PMR ${overall.pmrDeltaPct >= 0 ? '+' : ''}${Math.round(overall.pmrDeltaPct * 100)}% vs ${overall.prevDate}` : 'baseline (no prior day)'}`);
    log(`\n── Slack brief preview ─────────────────────\n${slackText}\n`);
    log(`Nothing was sent. Re-run with --send to email + post to Slack.`);
    if (OPEN) { try { (await import('node:child_process')).execSync(`open "${out}"`); } catch { /* ignore */ } }
    return;
  }

  // real send
  await sendEmail(subject, html, csv, `bundle_list_to_share_${reportDate}.csv`);
  await postSlack(slackText);
  log('\n✔ Sent: email to recipients + Slack brief posted.');
}

// ── Slack brief text (mrkdwn) from the summary ──
function buildSlackText(summaryText: string, reportDate: string, m: ReturnType<typeof computeMetrics>, overall: ReturnType<typeof overallDayOverDay>, nRecipients: number): string {
  const dod = overall && overall.pmrDeltaPct != null
    ? `${overall.pmrDeltaPct >= 0 ? '▲' : '▼'} ${overall.pmrDeltaPct >= 0 ? '+' : ''}${Math.round(overall.pmrDeltaPct * 100)}% vs ${overall.prevDate}`
    : 'baseline';
  let out = `*GCK Bundle Daily Brief — ${reportDate}*\n`;
  out += `PMR ${fmtCurrency(m.inAppPmr)}  (${dod})  ·  DSP spend ${fmtCurrency(m.inAppSpend)}\n`;
  for (const raw of summaryText.split('\n')) {
    const line = raw.trim();
    if (!line || /^executive summary$/i.test(line)) continue;
    const isCat = line.length <= 40 && /^[A-Za-z][A-Za-z &/()'-]*$/.test(line);
    if (isCat) out += `\n*${line}*\n`;
    else if (/^•/.test(line)) out += `${line}\n`;
    else out += `_${line}_\n`;   // the intro line
  }
  out += `\n_Full report emailed to ${nRecipients} recipient(s)._`;
  return out;
}

async function sendEmail(subject: string, html: string, csv: string, filename: string) {
  const user = env.EMAIL_USER; const pass = env.EMAIL_PASSWORD;
  if (!user || !pass) throw new Error('EMAIL_USER / EMAIL_PASSWORD not set in server/.env');
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.office365.com', port: parseInt(env.SMTP_PORT || '587', 10),
    secure: false, auth: { user, pass },
  });
  await transporter.sendMail({ from: user, to: recipients.join(', '), subject, html, attachments: [{ filename, content: csv }] });
  log(`  ✔ Email sent to ${recipients.length} recipient(s).`);
}

async function postSlack(text: string) {
  if (!POST_TOKEN || !POST_CHANNEL) { log('  ⚠ SLACK_BOT_TOKEN / SLACK_CHANNEL not set — skipping Slack post.'); return; }
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${POST_TOKEN}` },
    body: JSON.stringify({ channel: POST_CHANNEL, text }),
  });
  const j = await r.json() as { ok: boolean; error?: string };
  if (!j.ok) throw new Error(`Slack chat.postMessage: ${j.error}`);
  log(`  ✔ Slack brief posted to ${POST_CHANNEL}.`);
}

main().catch((e) => { console.error('\n✖ daily-brief failed:', e.message); process.exit(1); });

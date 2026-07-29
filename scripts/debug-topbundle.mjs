#!/usr/bin/env node
// ─────────────────────────────────────────────
// Debug helper for Top Bundle & Domain Analysis — verifies Slack + LLM from the
// CLI, reading config from server/.env. No UI needed.
//
// Usage:
//   node scripts/debug-topbundle.mjs slack <channelId> [filenameMatch]
//   node scripts/debug-topbundle.mjs llm   [model]
//   node scripts/debug-topbundle.mjs all   <channelId> [filenameMatch]
//
// Reads (from server/.env):
//   LOOKER_SLACK_BOT_TOKEN  (falls back to SLACK_BOT_TOKEN)
//   BRAIN_LLM_ENDPOINT      (default https://stagellm.pubmatic.com/v1/chat/completions)
//   BRAIN_LLM_API_KEY, BRAIN_LLM_MODEL (default "(paid) gpt-4o-mini")
// ─────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Papa from 'papaparse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '../server/.env');

function loadEnv(path) {
  const env = {};
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch { console.error(`⚠️  Could not read ${path} — is server/.env created? (cp server/.env.example server/.env)`); return env; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const mask = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)} (len ${s.length})` : '(empty)');
const env = loadEnv(ENV_PATH);

async function testSlack(channel, match = '') {
  console.log('\n=== SLACK ===');
  const token = env.LOOKER_SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN;
  console.log(`token: ${mask(token)} · channel: ${channel} · match: ${match || '(none)'}`);
  if (!token) return console.error('❌ No LOOKER_SLACK_BOT_TOKEN / SLACK_BOT_TOKEN in server/.env');
  if (!channel) return console.error('❌ Pass a channel id: node scripts/debug-topbundle.mjs slack <channelId>');

  const listResp = await fetch(`https://slack.com/api/files.list?channel=${encodeURIComponent(channel)}&count=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = await listResp.json();
  if (!list.ok) return console.error(`❌ files.list error: ${list.error}\n   (check scopes files:read/groups:history, and that the bot is IN the channel)`);

  const csvs = (list.files || []).filter((f) =>
    (f.filetype === 'csv' || String(f.name || '').toLowerCase().endsWith('.csv'))
    && (!match || String(f.name || '').toLowerCase().includes(match.toLowerCase())));
  console.log(`found ${list.files?.length ?? 0} files in channel, ${csvs.length} matching CSV(s)`);
  if (!csvs.length) return console.error('❌ No matching CSV file found.');
  csvs.sort((a, b) => (b.created || 0) - (a.created || 0));
  const file = csvs[0];
  console.log(`✅ latest CSV: "${file.name}" (created ${new Date((file.created || 0) * 1000).toISOString()})`);

  const dl = await fetch(file.url_private_download || file.url_private, { headers: { Authorization: `Bearer ${token}` } });
  const csv = await dl.text();
  if (!dl.ok) return console.error(`❌ download failed: HTTP ${dl.status}`);
  console.log(`✅ downloaded ${csv.length} bytes`);

  const parsed = Papa.parse(csv.trim(), { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields || [];
  console.log(`\nROWS: ${parsed.data.length}`);
  console.log(`COLUMNS (${headers.length}):\n  ${headers.join('\n  ')}`);

  const platCol = headers.find((h) => /platform|environment|device|inventory/i.test(h));
  if (platCol) {
    const vals = [...new Set(parsed.data.map((r) => String(r[platCol] ?? '').trim()).filter(Boolean))];
    console.log(`\nPLATFORM column = "${platCol}" — distinct values:\n  ${vals.join('\n  ')}`);
  } else {
    console.log('\n⚠️  No obvious Platform/Environment column found — send me the column list above.');
  }
}

async function testLlm(model) {
  console.log('\n=== LLM (PubMatic Brain) ===');
  const key = env.BRAIN_LLM_API_KEY;
  const endpoint = env.BRAIN_LLM_ENDPOINT || 'https://stagellm.pubmatic.com/v1/chat/completions';
  const useModel = model || env.BRAIN_LLM_MODEL || '(paid) claude-sonnet-5';
  console.log(`endpoint: ${endpoint}\nkey: ${mask(key)} · model: ${useModel}`);
  if (!key) return console.error('❌ No BRAIN_LLM_API_KEY in server/.env');

  const t0 = Date.now();
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: useModel, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 50 }),
  });
  const text = await resp.text();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!resp.ok) return console.error(`❌ HTTP ${resp.status} in ${secs}s: ${text.slice(0, 300)}`);
  let reply = '';
  try { reply = JSON.parse(text)?.choices?.[0]?.message?.content ?? ''; } catch { /* ignore */ }
  console.log(`✅ ${resp.status} in ${secs}s — reply: "${(reply || text).trim().slice(0, 80)}"`);
}

async function listModels() {
  console.log('\n=== MODELS (available for your key) ===');
  const key = env.BRAIN_LLM_API_KEY;
  const endpoint = env.BRAIN_LLM_ENDPOINT || 'https://stagellm.pubmatic.com/v1/chat/completions';
  const url = endpoint.replace(/\/chat\/completions\/?$/, '/models');
  console.log(`GET ${url}\nkey: ${mask(key)}`);
  if (!key) return console.error('❌ No BRAIN_LLM_API_KEY in server/.env');

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  const text = await resp.text();
  if (!resp.ok) return console.error(`❌ HTTP ${resp.status}: ${text.slice(0, 400)}`);

  let data;
  try { data = JSON.parse(text); } catch { console.log(text.slice(0, 2000)); return; }
  const ids = (data.data || data.models || []).map((m) => m.id || m.name || m).filter(Boolean);
  console.log(`✅ ${ids.length} model(s) available:`);
  for (const id of ids) console.log(`  ${id}`);
  const claude = ids.filter((id) => /claude/i.test(String(id)));
  if (claude.length) console.log(`\n👉 Claude models (put the best one in BRAIN_LLM_MODEL):\n  ${claude.join('\n  ')}`);
}

async function llmRaw(model) {
  console.log("\n=== LLM RAW (full response for a realistic prompt) ===");
  const key = env.BRAIN_LLM_API_KEY;
  const endpoint = env.BRAIN_LLM_ENDPOINT || "https://stagellm.pubmatic.com/v1/chat/completions";
  const useModel = model || env.BRAIN_LLM_MODEL || "(paid) claude-sonnet-5";
  console.log(`endpoint: ${endpoint}\nkey: ${mask(key)} · model: ${useModel}`);
  if (!key) return console.error("❌ No BRAIN_LLM_API_KEY in server/.env");
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: useModel, max_tokens: 800, messages: [
      { role: "system", content: "You are an ad-tech analyst. Write an executive summary." },
      { role: "user", content: "In-app DSP spend was $113K across APAC, EMEA and Americas. Top publisher Novi Digital drove 28%. Write a 4-sentence executive summary with one recommendation." },
    ] }),
  });
  const text = await resp.text();
  console.log(`\nHTTP ${resp.status}\nFULL RESPONSE:\n${text}`);
}

async function llmProxy() {
  console.log("\n=== LLM via local proxy (replicates the app path) ===");
  const url = "http://localhost:3001/api/llm";
  console.log(`POST ${url}`);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.BRAIN_LLM_MODEL || "(paid) claude-sonnet-5", max_tokens: 2000, messages: [
      { role: "system", content: "You are an ad-tech analyst. Write an executive summary." },
      { role: "user", content: "In-app DSP spend was $113K across APAC, EMEA and Americas. Top publisher Novi Digital drove 28%. Write a 4-sentence executive summary with one recommendation." },
    ] }),
  });
  const text = await resp.text();
  console.log(`\nHTTP ${resp.status}\nFULL RESPONSE:\n${text}`);
}

async function llmBig(maxTokensArg, modelArg) {
  const maxTokens = parseInt(maxTokensArg, 10) || 2000;
  const key = env.BRAIN_LLM_API_KEY;
  const endpoint = env.BRAIN_LLM_ENDPOINT || "https://stagellm.pubmatic.com/v1/chat/completions";
  const model = modelArg || env.BRAIN_LLM_MODEL || "(paid) claude-sonnet-5";
  const t0 = Date.now();
  console.log(`\n=== LLM BIG (real long system prompt, model=${model}, max_tokens=${maxTokens}) ===`);
  if (!key) return console.error("❌ No BRAIN_LLM_API_KEY");
  const system = "You are a senior programmatic revenue analyst delivering an EXECUTIVE BRIEFING to your team (GCK, a mobile in-app POD within APAC), "
    + "the way an agency or DSP briefs an advertiser. You are given pre-aggregated summary tables. "
    + "CRITICAL: do NOT just restate or list the tables. INTERPRET them. Write with a confident, analytical point of view. "
    + "Structure: (1) EXECUTIVE SUMMARY (4-6 sentences); (2) KEY FINDINGS (4-8 bullets each backed by a number); (3) RECOMMENDATIONS. "
    + "Lead with insight; cite numbers only to support a point. Do NOT invent numbers. Plain prose, no emoji.";
  let user = "Date: 2026-07-27\nTotals — DSP spend $112,977, PMR $19,118, publisher revenue $110,431.\n\n## By region\nAPAC $73,985 (65%); EMEA $31,727 (28%); Americas $7,264 (6%)\n\n## By POD\nSAsia $32,060; GCK $30,346; MENA $22,742; SEA $11,578\n\n## Top bundles\n";
  for (let i = 1; i <= 20; i++) user += `Bundle${i} (com.example.app${i}): $${(2000 - i * 80).toLocaleString()} (${(20 - i)}%) eCPM $${(1 + i * 0.5).toFixed(2)}\n`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  const text = await resp.text();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  let contentLen = 0, finish = '?', usage = '';
  try { const d = JSON.parse(text); contentLen = (d?.choices?.[0]?.message?.content || '').length; finish = d?.choices?.[0]?.finish_reason; usage = JSON.stringify(d?.usage || {}); } catch { /* ignore */ }
  console.log(`\nHTTP ${resp.status} in ${secs}s · content length=${contentLen} · finish_reason=${finish} · usage=${usage}`);
  console.log(`FULL RESPONSE:\n${text}`);
}

const [cmd, a, b] = process.argv.slice(2);
// Channel/match fall back to server/.env (LOOKER_SLACK_CHANNEL / LOOKER_SLACK_MATCH).
const channel = a || env.LOOKER_SLACK_CHANNEL || '';
const match = b || env.LOOKER_SLACK_MATCH || '';
try {
  if (cmd === 'slack') await testSlack(channel, match);
  else if (cmd === 'llm') await testLlm(a);
  else if (cmd === 'llmraw') await llmRaw(a);
  else if (cmd === 'llmproxy') await llmProxy();
  else if (cmd === 'llmbig') await llmBig(a, b);
  else if (cmd === 'models') await listModels();
  else if (cmd === 'all') { await testSlack(channel, match); await testLlm(); }
  else {
    console.log('Usage (channel/match default to LOOKER_SLACK_CHANNEL/LOOKER_SLACK_MATCH in server/.env):\n  node scripts/debug-topbundle.mjs slack  [channelId] [filenameMatch]\n  node scripts/debug-topbundle.mjs models\n  node scripts/debug-topbundle.mjs llm    [model]\n  node scripts/debug-topbundle.mjs all    [channelId] [filenameMatch]');
  }
} catch (err) {
  console.error(`\n💥 ${err.message}`);
  process.exit(1);
}

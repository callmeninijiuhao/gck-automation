// ─────────────────────────────────────────────
// PubMatic admin-custom-report/export 拉取（经 localhost 代理）
// 5xx / 网络错误做 3 次指数退避重试
// ─────────────────────────────────────────────
import Papa from 'papaparse';
import { DiscrepancyRow, DiscrepancyTokens, DISCREPANCY_CONFIG, PublisherFetchError, RunProgress } from './types';
import { standardizeRows, validateRows } from './dataProcessor';
import { isTauri, nativeFetch } from './nativeBridge';

const PROXY_PORT = (import.meta as any).env?.VITE_PROXY_PORT || 3001;
export const PROXY_BASE = `http://localhost:${PROXY_PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Translate a raw error message into a human-readable probable cause */
export function diagnoseError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed') || m.includes('econnrefused')) {
    return isTauri()
      ? 'Network error — check your internet connection / VPN.'
      : 'Cannot reach the local proxy server — make sure it is running (`npm run proxy`, port 3001).';
  }
  if (m.includes('error sending request') || m.includes('dns error') || m.includes('connection refused') || m.includes('connection reset')) {
    return 'Network error — check your internet connection / VPN, then retry.';
  }
  if (m.includes('http 401') || m.includes('unauthorized')) {
    return 'Authentication failed — the Bearer token or Pubtoken is invalid or expired. Generate/refresh tokens on the Token Management page.';
  }
  if (m.includes('http 403')) {
    return 'Access denied — the token has no permission for this publisher/report, or the proxy blocked the URL.';
  }
  if (m.includes('http 404')) {
    return 'Report endpoint or parameters not found — the report ID/params may have changed on PubMatic side.';
  }
  if (m.includes('http 429')) {
    return 'Rate limited by PubMatic — too many requests. Wait a few minutes and retry.';
  }
  if (/http 5\d\d/.test(m)) {
    return 'PubMatic server error — usually transient. Already retried 3 times; try again later.';
  }
  if (m.includes('timeout') || m.includes('timed out')) {
    return 'Request timed out — PubMatic API is slow or unreachable. Try again later.';
  }
  if (m.includes('json') && m.includes('parse')) {
    return 'Response could not be parsed — the API may have returned an HTML error page (often an auth/session issue).';
  }
  return '';
}

function buildReportUrl(publisherId: string, fromDate: string, toDate: string): string {
  const params = new URLSearchParams({
    reportName: DISCREPANCY_CONFIG.reportName,
    resourceType: DISCREPANCY_CONFIG.resourceType,
    resourceId: publisherId,
    reportId: DISCREPANCY_CONFIG.reportId,
    reportType: DISCREPANCY_CONFIG.reportType,
    fromDate,
    toDate,
  });
  return `${DISCREPANCY_CONFIG.apiBase}?${params.toString()}`;
}

async function fetchOnce(
  publisherId: string,
  fromDate: string,
  toDate: string,
  tokens: DiscrepancyTokens,
  onLog?: LogFn
): Promise<DiscrepancyRow[]> {
  const targetUrl = buildReportUrl(publisherId, fromDate, toDate);

  let text: string;
  if (isTauri()) {
    // Desktop app: direct request via Rust native_fetch — no proxy needed
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${tokens.bearerToken}`,
      Pubtoken: tokens.pubtoken,
    };
    if (tokens.cookie) headers['Cookie'] = tokens.cookie;
    const res = await nativeFetch(targetUrl, { headers });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
      (err as any).status = res.status || undefined;
      throw err;
    }
    text = res.text;
  } else {
    // Dev/browser: go through the localhost proxy (CORS + Cookie header restrictions)
    const proxied = `${PROXY_BASE}/proxy?url=${encodeURIComponent(targetUrl)}`;
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${tokens.bearerToken}`,
      Pubtoken: tokens.pubtoken,
    };
    // Browsers cannot set the Cookie header directly; the proxy maps x-pm-cookie → Cookie
    if (tokens.cookie) headers['x-pm-cookie'] = tokens.cookie;

    const resp = await fetch(proxied, { headers });
    text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
      (err as any).status = resp.status;
      throw err;
    }
  }

  // 响应可能是 JSON 或 CSV
  let rawRows: Record<string, unknown>[];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    rawRows = Array.isArray(data) ? data : (data.data ?? []);
  } else {
    rawRows = parseCsvWithRepair(trimmed, publisherId, onLog);
  }

  // 最终防线：仍然串位的脏行（DSP 名是数字 / 曝光数带小数等）整行剔除并记录
  const { valid, dropped } = validateRows(standardizeRows(rawRows, publisherId));
  if (dropped.length > 0) {
    const sample = dropped[0];
    onLog?.('warn',
      `Publisher ${publisherId}: dropped ${dropped.length} unrepairable malformed row(s) ` +
      `(e.g. DSP="${sample.dsp}") — check the raw report for this publisher.`);
  }
  return valid;
}

/**
 * 解析 CSV 并修复 PubMatic API 偶发的两类坏记录（尽量保数据，而不是丢弃）：
 * 1. 记录被换行截断成多行（如 "...,164352\n,\"Mobwith Co., Ltd\",..."）→ 按接缝拼接还原；
 * 2. 文本字段里未加引号的逗号导致字段数超出表头 → 把多余字段并回 Publisher 列。
 * 修复/丢弃情况都会写入 Run Log。
 */
export function parseCsvWithRepair(
  csvText: string,
  publisherId: string,
  onLog?: LogFn
): Record<string, unknown>[] {
  const parsed = Papa.parse<string[]>(csvText, { header: false, skipEmptyLines: true });
  const lines = parsed.data;
  if (lines.length < 2) return [];

  const header = lines[0].map((h) => String(h ?? '').trim());
  const n = header.length;
  const pubIdx = header.indexOf('Publisher');

  const records: string[][] = [];
  let repairedSplit = 0;
  let repairedOverflow = 0;
  let droppedFragments = 0;

  let i = 1;
  while (i < lines.length) {
    let cur = [...lines[i]];

    // 情况 1：字段数不足 → 记录被换行截断，与后续行按接缝拼接（最多拼 3 行）
    let joins = 0;
    while (cur.length < n && i + 1 < lines.length && joins < 3) {
      const next = lines[i + 1];
      cur = [
        ...cur.slice(0, -1),
        `${cur[cur.length - 1] ?? ''}${next[0] ?? ''}`,
        ...next.slice(1),
      ];
      i += 1;
      joins += 1;
    }

    if (cur.length === n) {
      if (joins > 0) repairedSplit += 1;
      records.push(cur);
    } else if (cur.length > n && pubIdx >= 0) {
      // 情况 2：字段数超出 → Publisher 名里有未加引号的逗号，把多余字段并回去
      const k = cur.length - n;
      cur = [
        ...cur.slice(0, pubIdx),
        cur.slice(pubIdx, pubIdx + k + 1).join(','),
        ...cur.slice(pubIdx + k + 1),
      ];
      repairedOverflow += 1;
      records.push(cur);
    } else {
      droppedFragments += 1;
    }
    i += 1;
  }

  if (repairedSplit > 0 || repairedOverflow > 0) {
    onLog?.('warn',
      `Publisher ${publisherId}: repaired ${repairedSplit + repairedOverflow} malformed CSV record(s) ` +
      `(${repairedSplit} split across lines, ${repairedOverflow} with unquoted comma) — data preserved`);
  }
  if (droppedFragments > 0) {
    onLog?.('warn', `Publisher ${publisherId}: dropped ${droppedFragments} unrepairable CSV fragment(s)`);
  }

  return records.map((rec) => Object.fromEntries(header.map((h, idx) => [h, rec[idx]])));
}

export async function fetchDiscrepancyData(
  publisherId: string,
  fromDate: string,
  toDate: string,
  tokens: DiscrepancyTokens,
  onLog?: LogFn
): Promise<DiscrepancyRow[]> {
  const maxRetries = 3;
  const baseDelay = 2000;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchOnce(publisherId, fromDate, toDate, tokens, onLog);
    } catch (err) {
      lastError = err as Error;
      const status = (err as any).status as number | undefined;
      const retryable = status === undefined || (status >= 500 && status < 600);
      if (retryable && attempt < maxRetries) {
        const delay = baseDelay * 2 ** (attempt - 1);
        onLog?.('warn', `Publisher ${publisherId}: attempt ${attempt}/${maxRetries} failed (${lastError.message.slice(0, 120)}), retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error('Unknown fetch error');
}

/** 批量拉取（3 并发），返回合并行 + 每个失败 publisher 的错误 */
export async function fetchAllPublishers(
  publisherIds: string[],
  fromDate: string,
  toDate: string,
  tokens: DiscrepancyTokens,
  onProgress?: (p: RunProgress) => void,
  onLog?: LogFn
): Promise<{ rows: DiscrepancyRow[]; errors: PublisherFetchError[] }> {
  const rows: DiscrepancyRow[] = [];
  const errors: PublisherFetchError[] = [];
  let done = 0;
  const concurrency = 3;
  const queue = [...publisherIds];

  const worker = async () => {
    while (queue.length) {
      const pubId = queue.shift();
      if (!pubId) break;
      try {
        const r = await fetchDiscrepancyData(pubId, fromDate, toDate, tokens, onLog);
        // Loop-push (not `rows.push(...r)`): spreading a large array overflows the call stack.
        for (let i = 0; i < r.length; i++) rows.push(r[i]);
      } catch (err) {
        const msg = (err as Error).message;
        errors.push({ publisherId: pubId, error: msg });
        const hint = diagnoseError(msg);
        onLog?.('error', `Publisher ${pubId}: FAILED — ${msg.slice(0, 200)}${hint ? `\n           ↳ Probable cause: ${hint}` : ''}`);
      } finally {
        done += 1;
        onProgress?.({ current: done, total: publisherIds.length, publisherId: pubId });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, publisherIds.length) }, worker));
  return { rows, errors };
}

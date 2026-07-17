/**
 * Resolves a dot-notation JSON path on an object.
 * e.g., "data.deals" on { data: { deals: [...] } }
 * @param obj - The target object.
 * @param path - The dot-notation path.
 * @returns The resolved value or undefined.
 */
function resolveJsonPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Normalizes deal objects to extract the deal ID string.
 * @param deal - The deal object or string.
 * @returns The deal ID or null.
 */
function extractDealId(deal: unknown): string | null {
  if (!deal) return null;
  if (typeof deal === 'string' || typeof deal === 'number') {
    return String(deal).trim();
  }
  const d = deal as Record<string, unknown>;
  const idKeys = ['dealMetaId', 'deal_meta_id', 'deal_id', 'dealId', 'id', 'deal', 'ap_id', 'apId'];
  for (const key of idKeys) {
    if (d[key] !== undefined && d[key] !== null) {
      return String(d[key]).trim();
    }
  }
  return null;
}

const PROXY_PORT = import.meta.env.VITE_PROXY_PORT || 3001;
const PROXY_BASE = `http://localhost:${PROXY_PORT}`;

/**
 * Detects whether the app is running inside a Tauri desktop shell.
 * In Tauri, direct HTTP requests are allowed (no CORS), so we skip the proxy.
 */
import { invoke } from '@tauri-apps/api/core';

function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI__;
}

async function fetchWithTauriBypass(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<Response> {
  if (isTauri()) {
    try {
      const responseText = await invoke<string>('native_fetch', {
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body || null,
      });

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => responseText,
        json: async () => JSON.parse(responseText),
      } as any;
    } catch (err: any) {
      let status = 500;
      let statusText = 'Internal Server Error';
      let text = String(err);

      const match = String(err).match(/^HTTP (\d+): (.*)$/);
      if (match) {
        status = parseInt(match[1], 10);
        statusText = 'Error';
        text = match[2];
      }

      return {
        ok: false,
        status,
        statusText,
        text: async () => text,
        json: async () => {
          try {
            return JSON.parse(text);
          } catch {
            return { error: text };
          }
        },
      } as any;
    }
  }

  return fetch(url, options);
}

/**
 * Checks whether the local CORS proxy is reachable.
 */
export async function checkProxyHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${PROXY_BASE}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (res.ok) return { ok: true };
    return { ok: false, error: `Proxy health returned HTTP ${res.status}` };
  } catch {
    return { ok: false, error: `Local proxy is not running on port ${PROXY_PORT}. Start it with: PROXY_PORT=${PROXY_PORT} npm run proxy` };
  }
}

/**
 * Returns mock deal data for demo/testing when real API is unavailable.
 * @param pubId - Publisher ID.
 * @returns Array of mock deal IDs.
 */
function getMockDealsForPublisher(pubId: string): string[] {
  const allMockDeals = [
    'DEAL_1001', 'DEAL_1002', 'DEAL_1003', 'DEAL_1004', 'DEAL_1005',
    'DEAL_2001', 'DEAL_2002', 'DEAL_2003', 'DEAL_2004', 'DEAL_2005',
    'DEAL_3001', 'DEAL_3002', 'DEAL_3003', 'DEAL_3004', 'DEAL_3005'
  ];
  const hash = pubId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const count = (hash % 8) + 1;
  const start = hash % allMockDeals.length;
  const deals: string[] = [];
  for (let i = 0; i < count; i++) {
    deals.push(allMockDeals[(start + i) % allMockDeals.length]);
  }
  return deals;
}

export interface ApiConfig {
  baseUrl: string;
  jsonPath: string;
  delayMs: number;
  concurrency: number;
  demoMode: boolean;
  fromDate?: string;
  toDate?: string;
  authToken?: string;
}

export async function fetchPublisherDeals(pubId: string, apiConfig: ApiConfig): Promise<string[]> {
  if (apiConfig.demoMode) {
    return getMockDealsForPublisher(pubId);
  }

  let url = apiConfig.baseUrl.replace('{pub_id}', encodeURIComponent(pubId));

  if (apiConfig.fromDate) {
    url = url.replace('{from_date}', encodeURIComponent(apiConfig.fromDate));
  }
  if (apiConfig.toDate) {
    url = url.replace('{to_date}', encodeURIComponent(apiConfig.toDate));
  }

  const runningInTauri = isTauri();
  const isDev = !runningInTauri && (import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  if (isDev) {
    const proxyHealth = await checkProxyHealth();
    if (!proxyHealth.ok) {
      throw new Error(proxyHealth.error);
    }
    url = `${PROXY_BASE}/proxy?url=${encodeURIComponent(url)}`;
  }

  const headers: Record<string, string> = {};
  if (apiConfig.authToken) {
    const auth = apiConfig.authToken.trim();
    headers['Authorization'] = /^bearer\s+/i.test(auth) ? auth : `Bearer ${auth}`;
  }

  const response = await fetchWithTauriBypass(url, { headers });

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status} ${response.statusText}`;
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text);
        const serverMsg = parsed.message || parsed.error || parsed.errorMessage || parsed.description || JSON.stringify(parsed);
        errorMsg += ` (${serverMsg})`;
      } catch {
        if (text && text.trim().length < 200) {
          errorMsg += ` (${text.trim()})`;
        }
      }
    } catch {
      // Ignore body read errors
    }

    if (errorMsg.includes('URL not allowed by proxy policy') || errorMsg.includes('not allowed')) {
      errorMsg += ' [Hint: Your network or a corporate proxy may be blocking this API URL. Try using a VPN, or check if your organization restricts outbound traffic.]';
    }
    if (response.status === 403) {
      errorMsg += ' [Hint: 403 usually means the token is invalid/expired, the IP is not allowlisted, or the endpoint requires different permissions.]';
    }
    if (response.status === 401) {
      errorMsg += ' [Hint: 401 means authentication failed. Check your token or try refreshing it.]';
    }

    throw new Error(errorMsg);
  }

  const json = await response.json();
  const rawDeals = resolveJsonPath(json, apiConfig.jsonPath);

  if (!rawDeals) {
    throw new Error(`Path "${apiConfig.jsonPath}" not found in response`);
  }

  if (!Array.isArray(rawDeals)) {
    throw new Error(`Expected an array at path "${apiConfig.jsonPath}", got ${typeof rawDeals}`);
  }

  const columns = (json.columns || []) as string[];
  const normalizedDeals = (rawDeals.length > 0 && Array.isArray(rawDeals[0]))
    ? rawDeals.map((row: unknown[]) => {
        const obj: Record<string, unknown> = {};
        columns.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj;
      })
    : rawDeals;

  return (normalizedDeals as unknown[])
    .map(extractDealId)
    .filter((id): id is string => id !== null);
}

export interface FetchProgressPayload {
  pubId: string;
  status: 'fetching' | 'success' | 'error';
  details: string;
  resultDealsCount?: number;
}

export interface FetchAllPublishersOptions {
  publishers: string[];
  apiConfig: ApiConfig;
  controlSignal?: { cancelled: boolean };
  onProgress: (pubId: string, status: 'fetching' | 'success' | 'error', details: string, resultDealsCount?: number) => void;
}

/**
 * Sequentially fetches deals for multiple publishers.
 * Supports cancellation and reporting progress.
 * @returns Key: publisher ID, Value: array of deal IDs.
 */
export async function fetchAllPublishers({
  publishers,
  apiConfig,
  controlSignal,
  onProgress
}: FetchAllPublishersOptions): Promise<Record<string, string[]>> {
  const monetizingMap: Record<string, string[]> = {};
  const delayMs = apiConfig.delayMs !== undefined ? apiConfig.delayMs : 200;
  const concurrency = apiConfig.concurrency !== undefined ? apiConfig.concurrency : 5;

  if (apiConfig.demoMode) {
    for (let i = 0; i < publishers.length; i += concurrency) {
      if (controlSignal?.cancelled) break;
      const batch = publishers.slice(i, i + concurrency);
      await Promise.all(batch.map(async (pubId) => {
        if (controlSignal?.cancelled) return;
        onProgress(pubId, 'fetching', 'Fetching deals (demo mode)...', 0);
        await new Promise(r => setTimeout(r, 150));
        const deals = getMockDealsForPublisher(pubId);
        monetizingMap[pubId] = deals;
        onProgress(pubId, 'success', `✓ [DEMO] Fetched ${deals.length} deals`, deals.length);
      }));
      if (i + concurrency < publishers.length && !controlSignal?.cancelled && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return monetizingMap;
  }

  for (let i = 0; i < publishers.length; i += concurrency) {
    if (controlSignal?.cancelled) {
      break;
    }

    const batch = publishers.slice(i, i + concurrency);

    const batchPromises = batch.map(async (pubId) => {
      if (controlSignal?.cancelled) return;

      onProgress(pubId, 'fetching', 'Fetching deals...', 0);

      try {
        const deals = await fetchPublisherDeals(pubId, apiConfig);
        monetizingMap[pubId] = deals;
        onProgress(pubId, 'success', `✓ Successfully fetched ${deals.length} deals`, deals.length);
      } catch (err) {
        monetizingMap[pubId] = [];
        let errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg === 'Failed to fetch' || errMsg === 'Load failed') {
          errMsg = 'Failed to fetch (Network error or server unreachable)';
        }
        onProgress(pubId, 'error', `✗ Failed: ${errMsg}`, 0);
      }
    });

    await Promise.all(batchPromises);

    if (i + concurrency < publishers.length && !controlSignal?.cancelled && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return monetizingMap;
}

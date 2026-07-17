const PROXY_PORT = import.meta.env.VITE_PROXY_PORT || 3001;
const PROXY_BASE = `http://localhost:${PROXY_PORT}`;

const TOKEN_API_BASE = 'https://api.pubmatic.com/v1/developer-integrations/developer';

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

function getApiUrl(endpoint: string): string {
  const isDev = !isTauri() && (import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const targetUrl = `${TOKEN_API_BASE}${endpoint}`;
  if (isDev) {
    return `${PROXY_BASE}/proxy?url=${encodeURIComponent(targetUrl)}`;
  }
  return targetUrl;
}

export interface GenerateTokenParams {
  userName: string;
  password: string;
  apiProduct?: string;
  accountId?: string;
  accountType?: string;
}

export interface RefreshTokenParams {
  email: string;
  apiProduct: string;
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  accountType?: string;
}

export interface TokenResponse {
  userEmail: string;
  tokenType: string;
  accessToken: string;
  refreshToken: string;
}

export async function generateToken(params: GenerateTokenParams): Promise<TokenResponse> {
  const body: Record<string, string> = {
    userName: params.userName,
    password: params.password,
  };
  if (params.apiProduct && params.apiProduct.trim()) body.apiProduct = params.apiProduct.trim();
  if (params.accountId) body.accountId = params.accountId;
  if (params.accountType) body.accountType = params.accountType;

  const url = getApiUrl('/token');
  const response = await fetchWithTauriBypass(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status} ${response.statusText}`;
    try {
      const text = await response.text();
      if (text) errorMsg += ` (${text})`;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

export async function refreshToken(params: RefreshTokenParams): Promise<TokenResponse> {
  const body: Record<string, string> = {
    email: params.email,
    refreshToken: params.refreshToken,
  };
  if (params.apiProduct && params.apiProduct.trim()) body.apiProduct = params.apiProduct.trim();
  if (params.accountId) body.accountId = params.accountId;
  if (params.accountType) body.accountType = params.accountType;

  const url = getApiUrl('/refreshToken');
  const response = await fetchWithTauriBypass(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${params.accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status} ${response.statusText}`;
    try {
      const text = await response.text();
      if (text) errorMsg += ` (${text})`;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

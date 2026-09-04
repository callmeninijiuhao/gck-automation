// ─────────────────────────────────────────────
// Tauri native bridge — lets the desktop app work WITHOUT the local proxy.
// - nativeFetch: HTTP via the Rust `native_fetch` command (bypasses CORS)
// - nativeSendEmail: SMTP via the Rust `send_email` command (lettre)
// In dev/browser mode these are not used; the localhost proxy is.
// ─────────────────────────────────────────────
import { invoke } from '@tauri-apps/api/core';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI__;
}

export interface NativeResponse {
  ok: boolean;
  /** 0 = network-level error (retryable) */
  status: number;
  text: string;
}

export async function nativeFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<NativeResponse> {
  try {
    const text = await invoke<string>('native_fetch', {
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ?? null,
    });
    return { ok: true, status: 200, text };
  } catch (err) {
    const m = String(err).match(/^HTTP (\d+): ([\s\S]*)$/);
    if (m) return { ok: false, status: parseInt(m[1], 10), text: m[2] };
    return { ok: false, status: 0, text: String(err) };
  }
}

/** Fetch a Looker Slack URL via the Rust `looker_fetch` command, which injects the
    embedded Looker token (kept in Rust — never reaches the frontend). */
export async function lookerFetch(url: string): Promise<NativeResponse> {
  try {
    const text = await invoke<string>('looker_fetch', { url });
    return { ok: true, status: 200, text };
  } catch (err) {
    const m = String(err).match(/^HTTP (\d+): ([\s\S]*)$/);
    if (m) return { ok: false, status: parseInt(m[1], 10), text: m[2] };
    return { ok: false, status: 0, text: String(err) };
  }
}

/** Non-secret Looker config baked into the desktop build: which channel to read and
    whether a token is available (so the fetch button can be enabled). */
export async function getLookerConfig(): Promise<{ channel: string; hasToken: boolean }> {
  try { return await invoke<{ channel: string; hasToken: boolean }>('get_looker_config'); }
  catch { return { channel: '', hasToken: false }; }
}

/** Fetch a Capacity Slack URL via the Rust `capacity_fetch` command, which injects the
    embedded Capacity token (kept in Rust — never reaches the frontend). */
export async function capacityFetch(url: string): Promise<NativeResponse> {
  try {
    const text = await invoke<string>('capacity_fetch', { url });
    return { ok: true, status: 200, text };
  } catch (err) {
    const m = String(err).match(/^HTTP (\d+): ([\s\S]*)$/);
    if (m) return { ok: false, status: parseInt(m[1], 10), text: m[2] };
    return { ok: false, status: 0, text: String(err) };
  }
}

/** Non-secret Capacity config baked into the desktop build: channel + token availability. */
export async function getCapacityConfig(): Promise<{ channel: string; hasToken: boolean }> {
  try { return await invoke<{ channel: string; hasToken: boolean }>('get_capacity_config'); }
  catch { return { channel: '', hasToken: false }; }
}

/** POST a chat-completions request via the Rust `llm_complete` command, which injects the
    embedded Brain key (kept in Rust — never reaches the frontend). `body` is raw JSON. */
export async function llmComplete(url: string, body: string): Promise<NativeResponse> {
  try {
    const text = await invoke<string>('llm_complete', { url, body });
    return { ok: true, status: 200, text };
  } catch (err) {
    const m = String(err).match(/^HTTP (\d+): ([\s\S]*)$/);
    if (m) return { ok: false, status: parseInt(m[1], 10), text: m[2] };
    return { ok: false, status: 0, text: String(err) };
  }
}

/** Non-secret LLM config baked into the desktop build: whether a Brain key is embedded and
    which instance (stage/prod) it targets. */
export async function getLlmConfig(): Promise<{ hasKey: boolean; environment: string }> {
  try { return await invoke<{ hasKey: boolean; environment: string }>('get_llm_config'); }
  catch { return { hasKey: false, environment: 'stage' }; }
}

/** SMTP credentials + Slack token, configured once in the app's Sending Settings */
export interface AppSendSettings {
  smtpHost: string;
  smtpPort: number;
  emailUser: string;
  emailPassword: string;
  slackBotToken: string;
}

export const DEFAULT_SEND_SETTINGS: AppSendSettings = {
  smtpHost: 'smtp.office365.com',
  smtpPort: 587,
  emailUser: '',
  emailPassword: '',
  slackBotToken: '',
};

export async function nativeSendEmail(
  settings: AppSendSettings | undefined,
  params: { subject: string; html: string; csv?: string; filename?: string; recipients: string[] }
): Promise<{ ok: boolean; error?: string; recipients?: string[] }> {
  try {
    // Empty credentials are fine when the build embeds them (Rust falls back).
    await invoke<string>('send_email', {
      smtpHost: settings?.smtpHost || '',
      smtpPort: settings?.smtpPort || 0,
      emailUser: settings?.emailUser || '',
      emailPassword: settings?.emailPassword || '',
      recipients: params.recipients,
      subject: params.subject,
      html: params.html,
      csv: params.csv ?? null,
      filename: params.filename ?? null,
    });
    return { ok: true, recipients: params.recipients };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function nativeSendSlack(params: {
  channel: string;
  blocks: object[];
  text: string;
  token?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke<string>('send_slack', {
      channel: params.channel,
      blocks: params.blocks,
      text: params.text,
      token: params.token || null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export interface SendConfigStatus {
  emailEmbedded: boolean;
  slackEmbedded: boolean;
}

/** Which credentials were embedded at build time (never returns secret values) */
export async function getSendConfig(): Promise<SendConfigStatus> {
  try {
    return await invoke<SendConfigStatus>('get_send_config');
  } catch {
    return { emailEmbedded: false, slackEmbedded: false };
  }
}

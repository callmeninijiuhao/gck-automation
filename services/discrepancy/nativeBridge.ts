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

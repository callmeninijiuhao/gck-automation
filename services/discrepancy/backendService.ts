// ─────────────────────────────────────────────
// Email / Slack sending — dual path:
// - Desktop app (Tauri): sends directly via Rust (SMTP) / native_fetch (Slack),
//   credentials come from the in-app Sending Settings. No proxy needed.
// - Dev/browser: goes through the local Express server (secrets in server/.env).
// ─────────────────────────────────────────────
import { PROXY_BASE } from './apiService';
import { isTauri, nativeSendEmail, nativeSendSlack, AppSendSettings } from './nativeBridge';

interface BackendResponse {
  ok: boolean;
  error?: string;
  recipients?: string[];
}

async function post(endpoint: string, body: object): Promise<BackendResponse> {
  const resp = await fetch(`${PROXY_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
  }
  return resp.json();
}

export async function sendEmail(
  params: {
    subject: string;
    html: string;
    csv?: string;
    filename?: string;
    recipients: string[];
  },
  settings?: AppSendSettings
): Promise<BackendResponse> {
  if (isTauri()) {
    // Rust prefers build-time embedded credentials and falls back to these settings.
    return nativeSendEmail(settings, params);
  }
  try {
    return await post('/api/send-email', params);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function sendSlack(
  params: { blocks: object[]; text: string; channel?: string },
  settings?: AppSendSettings
): Promise<BackendResponse> {
  if (isTauri()) {
    // Rust prefers the build-time embedded token and falls back to the settings token.
    // The embedded token never reaches the frontend.
    return nativeSendSlack({
      channel: params.channel || '#gck-discrepancy-checkin',
      blocks: params.blocks,
      text: params.text,
      token: settings?.slackBotToken || undefined,
    });
  }
  try {
    return await post('/api/slack', params);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─────────────────────────────────────────────
// Generic PubMatic Brain API client (OpenAI-compatible chat).
// Shared by all tools that call the Brain LLM (Top Bundle narrative,
// Discrepancy AI review, …). Tool-specific prompt building stays in
// each tool's own service; this module only owns transport + config.
//
// Two environments (see internal guidance):
//   - Non-prod (stage): https://stagellm.pubmatic.com   — dev/CICD, keys …-dev-stage / …-cicd-stage
//   - Production:        https://llm.pubmatic.com        — prod keys only
// You can only call non-prod → non-prod.
//
// Key handling mirrors the repo's secret pattern:
//   - Dev/browser: POST to the local server /api/llm; the Bearer key lives in server/.env.
//   - Desktop (Tauri): call the Brain API directly via native_fetch; the key is entered
//     in the tool's LLM settings and stored only on this computer (never in the git bundle).
// ─────────────────────────────────────────────
import { PROXY_BASE } from '@/services/discrepancy/apiService';
import { isTauri, nativeFetch } from '@/services/discrepancy/nativeBridge';

export type BrainEnv = 'stage' | 'prod';

export interface LlmConfig {
  environment: BrainEnv;
  /** e.g. "(paid) gpt-4o-mini", "anthropic.claude-3-7-sonnet-20250219-v1:0", "llama3.1:70b" */
  model: string;
  /** required for desktop (Tauri) direct calls; dev/browser uses server/.env */
  apiKey: string;
  temperature?: number;
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export const BRAIN_BASE_URL: Record<BrainEnv, string> = {
  stage: 'https://stagellm.pubmatic.com',
  prod: 'https://llm.pubmatic.com',
};

// Verified available on the Brain stage instance (names include the "(paid) " prefix).
export const BRAIN_MODELS = [
  '(paid) claude-sonnet-5',
  '(paid) claude-opus-4-8',
  '(paid) claude-opus-4-6-thinking',
  '(paid) claude-opus-4-6',
  '(paid) claude-sonnet-4-6-thinking',
  '(paid) claude-sonnet-4-6',
  '(paid) claude-sonnet-4.5',
  '(paid) claude-3-7-sonnet',
  '(paid) claude-3-5-sonnet',
  '(paid) claude-haiku-4.5',
  '(paid) claude-3-5-haiku',
  '(paid) gpt-4o',
  '(paid) gpt-4o-mini',
];

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  environment: 'stage',
  model: '(paid) claude-sonnet-5',
  apiKey: '',
  temperature: 0.3,
};

const endpointFor = (env: BrainEnv) => `${BRAIN_BASE_URL[env]}/v1/chat/completions`;

/** Pull the assistant text out of an OpenAI-compatible response. Handles Claude/Bedrock
    responses where message.content is an array of {type,text} blocks. */
export function extractContent(text: string): string {
  let data: any;
  try { data = JSON.parse(text); } catch { return ''; }
  let c = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  if (Array.isArray(c)) c = c.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
  return typeof c === 'string' ? c : '';
}

/** Low-level chat completion. Throws on transport / HTTP / API errors and on empty output. */
export async function chatComplete(messages: ChatMessage[], cfg: LlmConfig): Promise<string> {
  // NB: no `temperature` (newer Brain Claude models reject it). max_tokens must be
  // GENEROUS: sonnet-5 is a reasoning model whose internal "thinking" consumes the
  // token budget — too small (e.g. 2000) leaves nothing for visible content and the
  // response comes back empty. 8000 leaves room for reasoning + a full briefing.
  const payload = { model: cfg.model, messages, max_tokens: 8000 };

  let raw: string;
  if (isTauri()) {
    if (!cfg.apiKey) throw new Error('LLM API key not set — add it in the tool\'s LLM settings.');
    const res = await nativeFetch(endpointFor(cfg.environment), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    raw = res.text;
  } else {
    // Dev/browser: key is added server-side from server/.env.
    const resp = await fetch(`${PROXY_BASE}/api/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    raw = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 300)}`);
    // The server returns the raw upstream JSON, or { ok:false, error } on failure.
    try {
      const j = JSON.parse(raw);
      if (j && j.ok === false) throw new Error(j.error || 'LLM request failed');
    } catch (e) {
      if (e instanceof Error && e.message !== 'LLM request failed' && !/^Unexpected|JSON/.test(e.message)) throw e;
    }
  }

  const content = extractContent(raw);
  if (!content.trim()) throw new Error(`LLM returned empty content. Raw response: ${raw.slice(0, 1500)}`);
  return content;
}

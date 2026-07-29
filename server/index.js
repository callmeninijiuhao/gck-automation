import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Load server/.env (KIMI / EMAIL / SLACK secrets — never sent to the browser) ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        if (!(key in process.env)) process.env[key] = value;
    }
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.text());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PROXY_PORT || 3001;

// Backend access token must be provided via environment variable.
// NEVER hard-code tokens in source. Start with: BACKEND_ACCESS_TOKEN=xxx npm start
const BACKEND_ACCESS_TOKEN = process.env.BACKEND_ACCESS_TOKEN || '';

// Enable CORS for all origins (or restrict to your frontend domain)
app.use(cors());

// Security Configuration
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://brainprinter.io',
];

// Content Security Policy: Only allow fetching these types of data
const ALLOWED_PATTERNS = [
    /.*\/sellers\.json$/i,
    /.*\/app-ads\.txt$/i,
    /^https?:\/\/play\.google\.com\//i,
    /^https?:\/\/apps\.apple\.com\//i,
    /^https?:\/\/itunes\.apple\.com\//i,
    /^https?:\/\/api\.pubmatic\.com\//i,
    /^https?:\/\/apps\.pubmatic\.com\/api\/admin-custom-report\//i
];

// Middleware: Validate Origin
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
        console.warn(`Blocked request from unauthorized origin: ${origin}`);
    }
    next();
});

// Health check endpoint (used by AP Shooter)
app.get('/health', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
});

// Proxy Endpoint — supports all HTTP methods (GET, POST, PUT, DELETE, etc.)
app.all('/proxy', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing "url" query parameter' });
    }

    // NOTE: Express has already URL-decoded req.query.url once.
    // Do NOT decodeURIComponent again — it would corrupt encoded chars inside the target URL.
    const targetUrl = String(url);

    // Security Check: URL Whitelist
    const isAllowed = ALLOWED_PATTERNS.some(pattern => pattern.test(targetUrl));
    if (!isAllowed) {
        console.warn(`Blocked proxy request for disallowed URL: ${targetUrl}`);
        return res.status(403).json({ error: 'URL not allowed by proxy policy' });
    }

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        };

        // Forward Content-Type header if present
        if (req.headers['content-type']) {
            headers['Content-Type'] = req.headers['content-type'];
        }

        // For PubMatic API endpoints, prefer the user's Authorization header if provided,
        // otherwise fall back to the backend access token from env.
        if (req.headers.authorization) {
            headers['Authorization'] = req.headers.authorization;
        } else if (targetUrl.includes('api.pubmatic.com') && BACKEND_ACCESS_TOKEN) {
            headers['Authorization'] = `Bearer ${BACKEND_ACCESS_TOKEN}`;
        }

        // Discrepancy report (apps.pubmatic.com) needs extra headers.
        // Browsers cannot set "Cookie" directly, so the frontend sends "x-pm-cookie".
        if (req.headers['pubtoken']) headers['Pubtoken'] = req.headers['pubtoken'];
        if (req.headers['x-pm-cookie']) headers['Cookie'] = req.headers['x-pm-cookie'];
        if (req.headers['accept']) headers['Accept'] = req.headers['accept'];

        // Force https for api.pubmatic.com: node-fetch strips the Authorization
        // header on http→https redirects, causing auth failures upstream.
        const finalTargetUrl = targetUrl.replace(
            /^http:\/\/api\.pubmatic\.com/i,
            'https://api.pubmatic.com'
        );

        const fetchOptions = {
            method: req.method,
            headers,
        };

        // Forward request body for POST, PUT, PATCH
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
            fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }

        const response = await fetch(finalTargetUrl, fetchOptions);

        // Forward response status and content type
        res.status(response.status);
        const contentType = response.headers.get('content-type');
        if (contentType) {
            res.setHeader('Content-Type', contentType);
        }

        const text = await response.text();

        // Log upstream failures so the real error is visible in the proxy console
        if (!response.ok) {
            console.error(
                `[Proxy] Upstream ${response.status} ${response.statusText} for ${finalTargetUrl}\n` +
                `[Proxy] Auth header present: ${!!headers['Authorization']}\n` +
                `[Proxy] Upstream body: ${text.slice(0, 500)}`
            );
        }

        res.send(text);
    } catch (error) {
        console.error(`Proxy error for ${targetUrl}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch content', details: error.message });
    }
});

// ─────────────────────────────────────────────
// Discrepancy Check-in backend endpoints
// Secrets (email password, Slack token) live in server/.env
// and are NEVER exposed to the browser.
// ─────────────────────────────────────────────

// POST /api/send-email — send report email with optional CSV attachment
app.post('/api/send-email', async (req, res) => {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASSWORD;
    if (!user || !pass) {
        return res.status(200).json({ ok: false, error: 'EMAIL_USER / EMAIL_PASSWORD not configured on server' });
    }
    const { subject, html, csv, filename, recipients } = req.body || {};
    if (!subject || !html) return res.status(400).json({ ok: false, error: 'Missing "subject" or "html"' });

    const toList = (recipients && recipients.length ? recipients : (process.env.EMAIL_RECIPIENTS || 'gckops@pubmatic.com').split(','))
        .map(r => String(r).trim())
        .filter(Boolean);

    try {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.office365.com',
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: false, // STARTTLS
            auth: { user, pass },
        });
        await transporter.sendMail({
            from: user,
            to: toList.join(', '),
            subject,
            html,
            attachments: csv ? [{ filename: filename || 'report.csv', content: csv }] : [],
        });
        console.log(`[Email] Sent "${subject}" to ${toList.join(', ')}`);
        res.json({ ok: true, recipients: toList });
    } catch (err) {
        console.error('[Email] Failed:', err.message);
        res.status(200).json({ ok: false, error: err.message });
    }
});

// POST /api/slack — post report blocks to Slack channel
app.post('/api/slack', async (req, res) => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        return res.status(200).json({ ok: false, error: 'SLACK_BOT_TOKEN not configured on server' });
    }
    const { blocks, text, channel } = req.body || {};
    if (!blocks && !text) return res.status(400).json({ ok: false, error: 'Missing "blocks" or "text"' });

    try {
        const response = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                channel: channel || process.env.SLACK_CHANNEL || '#gck-discrepancy-checkin',
                blocks,
                text: text || 'PubMatic Discrepancy Report',
            }),
        });
        const data = await response.json();
        if (!data.ok) {
            console.error('[Slack] API error:', data.error);
            return res.status(200).json({ ok: false, error: data.error });
        }
        console.log(`[Slack] Message posted to ${channel || process.env.SLACK_CHANNEL || '#gck-discrepancy-checkin'}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Slack] Failed:', err.message);
        res.status(200).json({ ok: false, error: err.message });
    }
});

// POST /api/llm — proxy to the PubMatic Brain API (OpenAI-compatible chat).
// The Bearer key lives in server/.env (BRAIN_LLM_API_KEY) and NEVER reaches the browser.
// Non-prod keys (…-dev-stage / …-cicd-stage) must use the stage endpoint.
app.post('/api/llm', async (req, res) => {
    const key = process.env.BRAIN_LLM_API_KEY;
    // Default to the non-prod (stage) instance for dev/CICD usage.
    const endpoint = process.env.BRAIN_LLM_ENDPOINT || 'https://stagellm.pubmatic.com/v1/chat/completions';
    if (!key) {
        return res.status(200).json({ ok: false, error: 'BRAIN_LLM_API_KEY not configured on server (server/.env)' });
    }
    const { model, messages, temperature, max_tokens } = req.body || {};
    if (!model || !messages) return res.status(400).json({ ok: false, error: 'Missing "model" or "messages"' });

    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
        };
        // Optional Langfuse tracing (only sent if configured).
        if (process.env.LANGFUSE_TRACE_METADATA) headers['langfuse_trace_metadata'] = process.env.LANGFUSE_TRACE_METADATA;
        if (process.env.LANGFUSE_TRACE_USER_ID) headers['langfuse_trace_user_id'] = process.env.LANGFUSE_TRACE_USER_ID;

        // Only forward temperature if the caller explicitly set one — newer Claude
        // models on Brain reject `temperature` (deprecated).
        const payload = { model, messages };
        if (temperature !== undefined && temperature !== null) payload.temperature = temperature;
        if (max_tokens !== undefined && max_tokens !== null) payload.max_tokens = max_tokens;
        const upstream = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        const text = await upstream.text();
        if (!upstream.ok) {
            console.error(`[LLM] Upstream ${upstream.status} for ${endpoint}: ${text.slice(0, 300)}`);
            return res.status(200).json({ ok: false, error: `HTTP ${upstream.status}: ${text.slice(0, 300)}` });
        }
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
        res.send(text);
    } catch (err) {
        console.error('[LLM] Failed:', err.message);
        res.status(200).json({ ok: false, error: err.message });
    }
});

// GET /api/slack/looker-latest?channel=<id>&match=<substr>
// Finds the newest CSV file Looker posted to a Slack channel and returns its text.
// Uses SLACK_BOT_TOKEN (server/.env) — needs files:read (private: groups:history) and
// the bot must be a member of the channel. Token never reaches the browser.
app.get('/api/slack/looker-latest', async (req, res) => {
    // Dedicated app/token for the Looker channel (separate from the Discrepancy bot).
    // Falls back to SLACK_BOT_TOKEN if a dedicated one isn't set.
    const token = process.env.LOOKER_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
    if (!token) return res.status(200).json({ ok: false, error: 'LOOKER_SLACK_BOT_TOKEN not configured on server (server/.env)' });
    // Channel/match come from the request, falling back to server/.env defaults.
    const channel = String(req.query.channel || process.env.LOOKER_SLACK_CHANNEL || '').trim();
    const match = String(req.query.match || process.env.LOOKER_SLACK_MATCH || '').trim().toLowerCase();
    if (!channel) return res.status(400).json({ ok: false, error: 'No channel — set LOOKER_SLACK_CHANNEL in server/.env or pass ?channel=' });

    try {
        const listResp = await fetch(`https://slack.com/api/files.list?channel=${encodeURIComponent(channel)}&count=100`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const list = await listResp.json();
        if (!list.ok) return res.status(200).json({ ok: false, error: `Slack files.list: ${list.error}` });

        const csvFiles = (list.files || []).filter((f) =>
            (f.filetype === 'csv' || String(f.name || '').toLowerCase().endsWith('.csv'))
            && (!match || String(f.name || '').toLowerCase().includes(match)));
        if (!csvFiles.length) return res.status(200).json({ ok: false, error: 'No matching CSV file found in that channel' });
        csvFiles.sort((a, b) => (b.created || 0) - (a.created || 0));
        const file = csvFiles[0];

        const dl = await fetch(file.url_private_download || file.url_private, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const csv = await dl.text();
        if (!dl.ok) return res.status(200).json({ ok: false, error: `Download failed: HTTP ${dl.status}` });

        console.log(`[Slack] Fetched Looker file "${file.name}" from ${channel} (${csv.length} bytes)`);
        res.json({ ok: true, filename: file.name || 'looker.csv', createdAt: file.created || null, csv });
    } catch (err) {
        console.error('[Slack] looker-latest failed:', err.message);
        res.status(200).json({ ok: false, error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy server running on port ${PORT}`);
});

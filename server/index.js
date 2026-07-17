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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy server running on port ${PORT}`);
});

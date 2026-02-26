// api/generate.js — Vercel Serverless Function
// Proxies requests to Anthropic, keeps API key server-side,
// and enforces per-IP rate limiting.

// ─── Rate Limit Config ──────────────────────────────────────────
const RATE_LIMIT_MAX     = 3;    // max requests per IP per window
const RATE_LIMIT_WINDOW  = 60 * 60 * 1000; // 1 hour in ms
const DAILY_GLOBAL_CAP   = 100;  // hard ceiling across ALL visitors per day

// In-memory stores (reset on cold start — fine for serverless)
const ipStore    = new Map(); // { ip: [timestamp, ...] }
let   dailyCount = 0;
let   dailyReset = Date.now() + 24 * 60 * 60 * 1000;

// ─── Helper: get real IP ────────────────────────────────────────
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ─── Helper: check & record rate limit ─────────────────────────
function checkRateLimit(ip) {
  const now = Date.now();

  // Reset daily counter if window has passed
  if (now > dailyReset) {
    dailyCount = 0;
    dailyReset = now + 24 * 60 * 60 * 1000;
  }

  // Check global daily cap
  if (dailyCount >= DAILY_GLOBAL_CAP) {
    return { allowed: false, reason: 'Daily limit reached. Please try again tomorrow.' };
  }

  // Get this IP's request timestamps, filter out old ones
  const timestamps = (ipStore.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW - now) / 60000);
    return {
      allowed: false,
      reason: `You've used your ${RATE_LIMIT_MAX} free analyses for this hour. Try again in ~${retryAfter} minute${retryAfter !== 1 ? 's' : ''}.`
    };
  }

  // Record this request
  timestamps.push(now);
  ipStore.set(ip, timestamps);
  dailyCount++;

  return { allowed: true };
}

// ─── Main Handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS headers (your own domain only in production)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const ip = getIP(req);
  const { allowed, reason } = checkRateLimit(ip);
  if (!allowed) {
    return res.status(429).json({ error: reason });
  }

  // Validate body
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.length < 20) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // Sanity cap on prompt size
  if (prompt.length > 12000) {
    return res.status(400).json({ error: 'Prompt too large' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfiguration — API key not set' });
  }

  // Call Anthropic with streaming
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 5000,
      stream: true,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!anthropicRes.ok) {
    const err = await anthropicRes.json().catch(() => ({}));
    return res.status(502).json({ error: err?.error?.message || 'Upstream API error' });
  }

  // Stream the SSE response straight through to the browser
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // Client disconnected — that's fine
  } finally {
    res.end();
  }
}

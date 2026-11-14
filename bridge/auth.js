// Bridge key (Nov 2026). The bridge is published on the internet through ngrok, and
// until now anyone with the URL could read positions and executions or POST
// /api/stage-order. Every request that arrives through ngrok (or from any other host)
// must now carry `X-Bridge-Key: <BRIDGE_KEY>`. Direct calls on this Mac (curl
// localhost, the hourly TWS capture) are allowed without it: ngrok also connects from
// 127.0.0.1, but it always adds X-Forwarded-For, so those are not treated as local.
// Preflight (OPTIONS) is let through so the browser can ask before sending the header.
// No BRIDGE_KEY set → open, as before (with a warning at start-up).
import crypto from 'node:crypto';

const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;

export function isDirectLocal(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return LOOPBACK.test(ip) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
}

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function bridgeKeyGuard(key = process.env.BRIDGE_KEY || '') {
  if (!key) console.warn('[BRIDGE] BRIDGE_KEY not set — the bridge is OPEN to anyone with the ngrok URL. Run bridge/setup-key.sh.');
  return (req, res, next) => {
    if (!key || req.method === 'OPTIONS' || isDirectLocal(req)) return next();
    const given = req.get('x-bridge-key') || '';
    if (given && same(given, key)) return next();
    res.status(401).json({ error: 'Bridge key required — add it in the app under Settings → IBKR Bridge.' });
  };
}

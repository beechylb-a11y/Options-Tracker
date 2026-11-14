// TWS capture (Nov 2026) — copies every TWS execution and the option positions into
// Supabase, so the Saturday review can check each recorded close against what TWS
// actually did. Run by launchd every hour (com.options-tracker.tws-capture.plist);
// safe to run any number of times: executions upsert on exec_id, and a positions
// snapshot is only written when the positions change.
//
//   node captureTws.js            one capture, exit 0 (also when TWS is down — logged)
//   node captureTws.js --dry      fetch and print, write nothing
//
// Reads DATABASE_URL (same value as server/.env) from bridge/.env or the environment.
// Talks only to the local bridge (localhost:3333) — never ngrok — and only GETs.

import './env.js';
import crypto from 'node:crypto';
import pg from 'pg';

const BRIDGE = process.env.CAPTURE_BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3333}`;
const TWS_TZ = process.env.TWS_TZ || 'America/New_York';   // TWS's own time zone setting
const DRY = process.argv.includes('--dry');

async function get(p, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BRIDGE + p, { signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p} → HTTP ${r.status} ${j.error || ''}`.trim());
    return j;
  } finally { clearTimeout(t); }
}

// Wall-clock time in a named zone → UTC Date, without a date library.
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asZone = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess - (asZone - guess));
}

// TWS sends "20261111  15:07:28", "20261111 15:07:28 US/Eastern" or "20261111-15:07:28".
function parseExecTime(raw) {
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})[\s-]+(\d{2}):(\d{2}):(\d{2})\s*(\S+)?/);
  if (!m) return null;
  const zone = m[7] && m[7] !== 'UTC' ? m[7].replace('US/Eastern', 'America/New_York') : (m[7] === 'UTC' ? 'UTC' : TWS_TZ);
  try { return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], zone); } catch { return null; }
}
const nyDate = d => d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d) : null;
const num = v => (v === null || v === undefined || v === '' || !isFinite(Number(v)) || Math.abs(Number(v)) > 1e300) ? null : Number(v);

async function main() {
  const started = Date.now();
  let health = {};
  const run = { ok: false, mode: null, accounts: null, executions: 0, new_executions: 0, positions: 0, positions_changed: false, error: null };
  const db = DRY ? null : new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false },
    max: 2
  });
  if (!DRY && !process.env.DATABASE_URL) { console.error('[capture] DATABASE_URL not set (bridge/.env)'); process.exit(1); }

  try {
    health = await get('/api/health', 10000);
    run.mode = health.mode || null;
    run.accounts = (health.accounts || []).join(',') || null;
    if (!health.connected) throw new Error('bridge up, TWS not connected' + (health.lastError ? ': ' + health.lastError : ''));

    // Everything TWS still holds (?all=1), not just today: an order sent one evening can
    // fill the next session, and a missed hour must not lose a fill.
    const ex = await get('/api/executions?all=1', 30000);
    const fills = ex.fills || [];
    run.executions = fills.length;

    const pos = await get('/api/positions', 20000);
    const legs = (pos.raw || []).map(l => ({ account: l.account, underlying: l.underlying, expiry: l.expiry,
      strike: l.strike, right: l.right, qty: l.qty, avgCost: l.avgCost, multiplier: l.multiplier }))
      .sort((a, b) => `${a.account}${a.underlying}${a.expiry}${a.right}${a.strike}`.localeCompare(`${b.account}${b.underlying}${b.expiry}${b.right}${b.strike}`));
    run.positions = legs.length;
    const hash = crypto.createHash('sha1').update(JSON.stringify(legs)).digest('hex');

    if (DRY) {
      console.log(JSON.stringify({ health, executions: fills.slice(0, 50), positions: legs }, null, 2));
      run.ok = true;
      return;
    }

    for (const f of fills) {
      if (!f.execId) continue;
      const ts = parseExecTime(f.time);
      const r = await db.query(
        `insert into options.tws_executions
           (exec_id, perm_id, order_id, order_ref, account, mode, exec_time_raw, exec_ts, ny_date, symbol, sec_type,
            expiry, strike, "right", side, qty, price, avg_price, multiplier, commission, realized_pnl, raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         on conflict (exec_id) do update set
           commission   = coalesce(nullif(excluded.commission, 0), options.tws_executions.commission),
           realized_pnl = coalesce(excluded.realized_pnl, options.tws_executions.realized_pnl),
           captured_at  = options.tws_executions.captured_at
         returning (xmax = 0) as inserted`,
        [f.execId, String(f.permId || ''), String(f.orderId ?? ''), f.orderRef || '', f.account || '', run.mode,
         String(f.time || ''), ts, nyDate(ts), f.symbol || '', f.secType || '', f.expiry || '', num(f.strike),
         f.right || '', f.side || '', num(f.qty), num(f.price), num(f.avgPrice), num(f.multiplier),
         num(f.commission), num(f.realizedPnl), f]);
      if (r.rows[0]?.inserted) run.new_executions++;
    }

    const last = await db.query(`select hash from options.tws_positions order by captured_at desc limit 1`);
    if (last.rows[0]?.hash !== hash) {
      await db.query(`insert into options.tws_positions (account, mode, hash, legs, structures) values ($1,$2,$3,$4,$5)`,
        [run.accounts, run.mode, hash, JSON.stringify(legs), JSON.stringify(pos.structures || [])]);
      run.positions_changed = true;
    }
    run.ok = true;
  } catch (e) {
    run.error = String(e.message || e).slice(0, 500);
  } finally {
    if (db) {
      try {
        await db.query(`insert into options.tws_capture_runs (ok, mode, accounts, executions, new_executions, positions, positions_changed, error)
                        values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [run.ok, run.mode, run.accounts, run.executions, run.new_executions, run.positions, run.positions_changed, run.error]);
      } catch (e) { console.error('[capture] heartbeat write failed:', e.message); }
      await db.end();
    }
    console.log(`[capture] ${new Date().toISOString()} ${run.ok ? 'ok' : 'FAILED'} · ${run.mode || '?'} ${run.accounts || ''} · ` +
      `${run.executions} execs (${run.new_executions} new) · ${run.positions} legs${run.positions_changed ? ' (changed)' : ''}` +
      `${run.error ? ' · ' + run.error : ''} · ${Date.now() - started} ms`);
  }
}

main();

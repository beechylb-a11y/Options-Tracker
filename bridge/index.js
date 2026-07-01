// ================================================================
//  IBKR TWS BRIDGE — Local market data server for Options Tracker
//  Connects to TWS on localhost:7496, serves REST API on :3333
//  Expose via ngrok for Railway app to call
// ================================================================
import express from 'express';
import cors from 'cors';
import { IBApi, EventName, SecType, BarSizeSetting, WhatToShow } from '@stoqey/ib';

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning']
}));

// Handle preflight explicitly
app.options('*', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, ngrok-skip-browser-warning'
  });
  res.sendStatus(204);
});
app.use(express.json());

const PORT = process.env.BRIDGE_PORT || 3333;
const TWS_HOST = process.env.TWS_HOST || '127.0.0.1';
const TWS_PORT = parseInt(process.env.TWS_PORT || '7496');
const CLIENT_ID = parseInt(process.env.CLIENT_ID || '99');

let ib = null;
let connected = false;
let nextReqId = 1000;

function getReqId() { return nextReqId++; }

// ── Connect to TWS ──
function connectTWS() {
  return new Promise((resolve, reject) => {
    if (connected && ib) { resolve(); return; }
    ib = new IBApi({ host: TWS_HOST, port: TWS_PORT, clientId: CLIENT_ID });

    ib.on(EventName.connected, () => {
      console.log('[BRIDGE] Connected to TWS');
      connected = true;
      // Request delayed data when real-time not subscribed
      ib.reqMarketDataType(3); // 3 = delayed-frozen (best available)
      resolve();
    });

    ib.on(EventName.disconnected, () => {
      console.log('[BRIDGE] Disconnected from TWS');
      connected = false;
    });

    ib.on(EventName.error, (err, code, reqId) => {
      if (code === 2104 || code === 2106 || code === 2158) return; // info messages
      console.error('[BRIDGE] TWS Error:', code, err?.message || err);
    });

    ib.connect();
    setTimeout(() => { if (!connected) reject(new Error('TWS connection timeout')); }, 5000);
  });
}

// ── Request market data snapshot ──
function getSnapshot(contract) {
  return new Promise((resolve, reject) => {
    const reqId = getReqId();
    const data = {};
    let resolved = false;

    const onTick = (id, field, value) => {
      if (id !== reqId) return;
      if (value <= 0) return; // ignore -1 placeholders and zero values
      // Real-time field IDs: 1=bid, 2=ask, 4=last, 6=high, 7=low, 9=close, 14=open
      // Delayed field IDs: 66=delayed_bid, 67=delayed_ask, 68=delayed_last, 72=delayed_high, 73=delayed_low, 75=delayed_close, 76=delayed_open
      if (field === 1 || field === 66) data.bid = value;
      if (field === 2 || field === 67) data.ask = value;
      if (field === 4 || field === 68) data.last = value;
      if (field === 6 || field === 72) data.high = value;
      if (field === 7 || field === 73) data.low = value;
      if (field === 9 || field === 75) data.prevClose = value;
      if (field === 14 || field === 76) data.open = value;
    };

    const onTickEnd = (id) => {
      if (id !== reqId || resolved) return;
      resolved = true;
      ib.removeListener(EventName.tickPrice, onTick);
      ib.removeListener(EventName.tickSnapshotEnd, onTickEnd);
      data.mid = (data.bid && data.ask) ? (data.bid + data.ask) / 2 : data.last;
      resolve(data);
    };

    ib.on(EventName.tickPrice, onTick);
    ib.on(EventName.tickSnapshotEnd, onTickEnd);
    ib.reqMktData(reqId, contract, '', false, false);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ib.removeListener(EventName.tickPrice, onTick);
        ib.removeListener(EventName.tickSnapshotEnd, onTickEnd);
        ib.cancelMktData(reqId);
        data.mid = (data.bid && data.ask) ? (data.bid + data.ask) / 2 : data.last;
        resolve(data);
      }
    }, 6000);
  });
}

// ── Request option model Greeks (delta/gamma/theta/vega/IV) ──
// Greeks only exist for a specific option contract. We request generic tick
// 106 which enables modelGreeks, then listen for tickOptionComputation.
// tickType 13 = model option computation (IBKR's theoretical greeks).
function getOptionGreeks(contract) {
  return new Promise((resolve) => {
    const reqId = getReqId();
    let resolved = false;
    let notSubscribed = false;
    const done = (data) => {
      if (resolved) return;
      resolved = true;
      ib.removeListener(EventName.tickOptionComputation, onGreeks);
      ib.removeListener(EventName.tickOptionComputation, rawDump);
      ib.removeListener(EventName.tickSnapshotEnd, onEnd);
      ib.removeListener(EventName.error, onErr);
      try { ib.cancelMktData(reqId); } catch (e) {}
      resolve(data);
    };
    // Confirmed from live RAW args dump on @stoqey/ib 1.3.x: 10 arguments,
    // (reqId, tickType, impliedVol, delta, optPrice, pvDividend, gamma, vega,
    // theta, undPrice). No tickAttrib/field arg. tickType 10-13 = the various
    // IV/greek computations; model greeks arrive as 13 (or 10-12 for bid/ask/last).
    const onGreeks = (id, tickType, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice) => {
      if (id !== reqId) return;
      // Require a usable delta; skip the null-filled ticks that arrive when the
      // options feed isn't subscribed (TWS still emits empty computations).
      if (delta == null || Number.isNaN(delta)) return;
      done({
        iv: impliedVol && impliedVol > 0 ? +(impliedVol * 100).toFixed(2) : null,
        delta: delta != null ? +Number(delta).toFixed(4) : null,
        gamma: gamma != null ? +Number(gamma).toFixed(5) : null,
        theta: theta != null ? +Number(theta).toFixed(4) : null,
        vega: vega != null ? +Number(vega).toFixed(4) : null,
        undPrice: undPrice != null && undPrice > 0 ? +Number(undPrice).toFixed(2) : null,
        tickType
      });
    };
    const onEnd = (id) => { if (id === reqId) done(null); };

    // Detect market-data-not-subscribed errors (10089/10090/10167/10168/354)
    // scoped to THIS request, so the endpoint can tell the user clearly.
    const onErr = (err, code, id) => {
      if (id !== reqId) return;
      if ([10089, 10090, 10091, 10167, 10168, 354, 10197].includes(code)) {
        notSubscribed = true;
      }
    };
    ib.on(EventName.error, onErr);

    ib.on(EventName.tickOptionComputation, onGreeks);
    // TEMP one-time raw-args dump to verify signature; remove once confirmed.
    const rawDump = (...args) => {
      console.log('[BRIDGE] tickOptionComputation RAW args:', JSON.stringify(args.map(a =>
        (typeof a === 'number' ? +a.toFixed(5) : a))));
      ib.removeListener(EventName.tickOptionComputation, rawDump);
    };
    ib.on(EventName.tickOptionComputation, rawDump);
    // genericTickList '106' = option implied vol / model greeks; snapshot=false
    // because greeks stream after a short delay; we time out ourselves.
    ib.reqMktData(reqId, contract, '106', false, false);

    setTimeout(() => done(notSubscribed ? { notSubscribed: true } : null), 7000);
    ib.on(EventName.tickSnapshotEnd, onEnd);
    // genericTickList '106' = option implied vol / model greeks; snapshot=false
    // because greeks stream after a short delay; we time out ourselves.
    ib.reqMktData(reqId, contract, '106', false, false);

    setTimeout(() => done(null), 7000);
  });
}

// Build an OCC-style option contract for a leg.
function buildOptionContract(underlying, expiry, strike, right) {
  // expiry: 'YYYYMMDD'; right: 'C' | 'P'
  const u = underlying.toUpperCase();
  const isIndex = ['SPX', 'RUT', 'VIX', 'NDX'].includes(u);
  return {
    symbol: u,
    secType: SecType.OPT,
    currency: 'USD',
    exchange: isIndex ? 'CBOE' : 'SMART',
    lastTradeDateOrContractMonth: expiry,
    strike: Number(strike),
    right: right.toUpperCase().startsWith('P') ? 'P' : 'C',
    multiplier: '100',
    tradingClass: (u === 'SPX') ? 'SPXW' : undefined  // 0DTE SPX uses weeklys
  };
}
function getHistoricalBars(contract, duration, barSize, whatToShow = WhatToShow.TRADES) {
  return new Promise((resolve, reject) => {
    const reqId = getReqId();
    const bars = [];
    let resolved = false;

    const onBar = (id, date, open, high, low, close, volume, count, WAP) => {
      if (id !== reqId) return;
      if (bars.length === 0) console.log('[BRIDGE] BAR DATA: date=' + date + ' o=' + open + ' h=' + high + ' l=' + low + ' c=' + close + ' v=' + volume);
      bars.push({ date, open, high, low, close, volume: volume || 0, count, WAP });
    };

    const onEnd = (id) => {
      if (id !== reqId || resolved) return;
      resolved = true;
      ib.removeListener(EventName.historicalData, onBar);
      ib.removeListener(EventName.historicalDataEnd, onEnd);
      resolve(bars);
    };

    ib.on(EventName.historicalData, onBar);
    ib.on(EventName.historicalDataEnd, onEnd);
    ib.reqHistoricalData(reqId, contract, '', duration, barSize, whatToShow, 1, 1, false);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ib.removeListener(EventName.historicalData, onBar);
        ib.removeListener(EventName.historicalDataEnd, onEnd);
        resolve(bars);
      }
    }, 8000);
  });
}

// ── Contract definitions ──
const contracts = {
  SPX: { symbol: 'SPX', secType: SecType.IND, exchange: 'CBOE', currency: 'USD' },
  RUT: { symbol: 'RUT', secType: SecType.IND, exchange: 'RUSSELL', currency: 'USD' },
  SPY: { symbol: 'SPY', secType: SecType.STK, exchange: 'SMART', primaryExch: 'ARCA', currency: 'USD' },
  QQQ: { symbol: 'QQQ', secType: SecType.STK, exchange: 'SMART', primaryExch: 'NASDAQ', currency: 'USD' },
  IWM: { symbol: 'IWM', secType: SecType.STK, exchange: 'SMART', primaryExch: 'ARCA', currency: 'USD' },
  VIX: { symbol: 'VIX', secType: SecType.IND, exchange: 'CBOE', currency: 'USD' },
  VIX1D: { symbol: 'VIX1D', secType: SecType.IND, exchange: 'CBOE', currency: 'USD' },
  ES: { symbol: 'ES', secType: SecType.FUT, exchange: 'CME', currency: 'USD', lastTradeDateOrContractMonth: '' },
};

// Get front-month ES contract
function getESContract() {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  const year = now.getFullYear();
  // ES quarterly months: Mar(2), Jun(5), Sep(8), Dec(11)
  const qMonths = [2, 5, 8, 11];
  let nextQ = qMonths.find(m => m > month);
  if (nextQ === undefined) { nextQ = 2; } // wrap to March next year
  let contractYear = nextQ <= month ? year + 1 : year;
  // If we're in the expiry month, check if past 3rd Friday
  if (qMonths.includes(month)) {
    const thirdFri = new Date(year, month, 1);
    while (thirdFri.getDay() !== 5) thirdFri.setDate(thirdFri.getDate() + 1);
    thirdFri.setDate(thirdFri.getDate() + 14);
    if (now <= thirdFri) {
      nextQ = month;
      contractYear = year;
    }
  }
  const ym = contractYear.toString() + String(nextQ + 1).padStart(2, '0');
  console.log('[BRIDGE] ES contract month:', ym);
  return {
    symbol: 'ES',
    secType: SecType.FUT,
    exchange: 'CME',
    currency: 'USD',
    lastTradeDateOrContractMonth: ym
  };
}

// ── Calculate ATR from bars ──
function calcATR(bars, period) {
  if (!bars || bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    // @stoqey/ib returns bars as array-like objects with numeric keys
    // Format: {0: date, 1: open, 2: high, 3: low, 4: close, 5: volume, 6: WAP, 7: count}
    const h = b.high ?? b[2] ?? 0;
    const l = b.low ?? b[3] ?? 0;
    const pc = prev.close ?? prev[4] ?? 0;
    if (h > 0 && l > 0 && pc > 0) {
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  if (trs.length === 0) return 0;
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((s, v) => s + v, 0) / n;
}

// ── Calculate VWAP from bars ──
function calcVWAP(bars) {
  let cumVP = 0, cumV = 0;
  const vwaps = [];
  bars.forEach(b => {
    const h = b.high ?? b[2] ?? 0;
    const l = b.low ?? b[3] ?? 0;
    const c = b.close ?? b[4] ?? 0;
    const vol = b.volume ?? b[5] ?? 0;
    const typical = (h + l + c) / 3;
    cumVP += typical * vol;
    cumV += vol;
    vwaps.push(cumV > 0 ? cumVP / cumV : c);
  });
  return vwaps;
}

const SQRT252 = Math.sqrt(252);

// ================================================================
//  MAIN ENDPOINT — GET /api/market-data?underlying=SPX
// ================================================================
app.get('/api/market-data', async (req, res) => {
  try {
    await connectTWS();
    const underlying = (req.query.underlying || 'SPX').toUpperCase();
    const usesSPYVwap = underlying === 'SPX';
    const usesIWMVwap = underlying === 'RUT';

    // 1. Get snapshots in parallel
    const mainContract = contracts[underlying] || contracts.SPX;
    const esContract = getESContract();
    const vwapContract = usesSPYVwap ? contracts.SPY : mainContract;

    const [mainSnap, vixSnap, vix1dSnap, esSnap] = await Promise.all([
      getSnapshot(mainContract),
      getSnapshot(contracts.VIX),
      getSnapshot(contracts.VIX1D).catch(() => ({})),
      getSnapshot(esContract)
    ]);

    const price = (mainSnap.mid && mainSnap.mid > 0) ? mainSnap.mid : (mainSnap.last > 0 ? mainSnap.last : 0);
    const high = mainSnap.high > 0 ? mainSnap.high : 0;
    const low = mainSnap.low > 0 ? mainSnap.low : 0;
    const cashOpen = mainSnap.open > 0 ? mainSnap.open : 0;
    const vix = vixSnap.mid || vixSnap.last || 0;
    const vix1d = vix1dSnap.mid || vix1dSnap.last || 0;

    // ES overnight data
    const esClose = esSnap.mid || esSnap.last || 0;
    const esPrevClose = esSnap.prevClose || 0;
    const esHigh = esSnap.high || 0;
    const esLow = esSnap.low || 0;

    // 2. Calculate EM
    const em = price > 0 && vix > 0 ? Math.round(price * (vix / 100) / SQRT252 * 10) / 10 : 0;
    const esEM = esClose > 0 && vix > 0 ? Math.round(esClose * (vix / 100) / SQRT252 * 10) / 10 : 0;

    // 3. Get historical bars for ATR calculations
    // SPX index has no MIDPOINT historical data — use SPY bars and scale ×10
    // RUT index — use IWM bars and scale by RUT/IWM ratio
    const histContract = (underlying === 'SPX') ? contracts.SPY : (underlying === 'RUT') ? contracts.IWM : mainContract;
    const histWhat = (histContract.secType === SecType.IND) ? WhatToShow.MIDPOINT : WhatToShow.TRADES;
    const atrScale = (underlying === 'SPX') ? 10 : (underlying === 'RUT') ? 1 : 1;
    console.log('[BRIDGE] Requesting historical bars for', underlying, 'using', histContract.symbol, 'scale:', atrScale);
    const [bars1D, bars5m, bars2h] = await Promise.all([
      getHistoricalBars(histContract, '20 D', BarSizeSetting.DAYS_ONE, histWhat).catch(e => { console.log('[BRIDGE] bars1D error:', e.message); return []; }),
      getHistoricalBars(histContract, '1 D', BarSizeSetting.MINUTES_FIVE, histWhat).catch(e => { console.log('[BRIDGE] bars5m error:', e.message); return []; }),
      getHistoricalBars(histContract, '5 D', BarSizeSetting.HOURS_TWO, histWhat).catch(e => { console.log('[BRIDGE] bars2h error:', e.message); return []; })
    ]);
    console.log('[BRIDGE] Bars received: 1D=' + bars1D.length + ' 5m=' + bars5m.length + ' 2h=' + bars2h.length);
    if (bars1D.length > 0) {
      const b = bars1D[0];
      console.log('[BRIDGE] Bar sample: date=' + (b[0]||b.date) + ' open=' + (b[1]||b.open) + ' high=' + (b[2]||b.high) + ' low=' + (b[3]||b.low) + ' close=' + (b[4]||b.close));
    }

    const atr1d = calcATR(bars1D, 14) * atrScale;
    const atr5m = calcATR(bars5m, 14) * atrScale;
    const atr2h = calcATR(bars2h, 14) * atrScale;
    console.log('[BRIDGE] ATR calculated: 1d=' + atr1d.toFixed(2) + ' 5m=' + atr5m.toFixed(4) + ' 2h=' + atr2h.toFixed(2));

    // Derive Open from first 5m bar if not available from snapshot
    let derivedOpen = cashOpen;
    if (!derivedOpen && bars5m.length > 0) {
      derivedOpen = (bars5m[0].open || 0) * atrScale;
    }

    // 4. Fallback prices — start with snapshot, override later if needed
    let finalPrice = price;
    let finalHigh = high;
    let finalLow = low;

    // Derive from ATR bars if snapshot was 0
    if (!finalPrice && bars5m.length > 0) {
      const lastBar = bars5m[bars5m.length - 1];
      const barClose = (lastBar.close || 0) * atrScale;
      if (barClose > 0) {
        finalPrice = barClose;
        console.log('[BRIDGE] Price derived from last 5m bar:', finalPrice);
      }
    }
    if (!finalHigh && bars1D.length > 0) {
      const barHigh = (bars1D[bars1D.length - 1].high || 0) * atrScale;
      if (barHigh > 0) finalHigh = barHigh;
    }
    if (!finalLow && bars1D.length > 0) {
      const barLow = (bars1D[bars1D.length - 1].low || 0) * atrScale;
      if (barLow > 0) finalLow = barLow;
    }

    // 5. VWAP from 5-min bars
    // Indices need SPY/QQQ for volume. If unavailable, skip VWAP.
    let vwap5 = 0, vwap5_30 = 0, vwap15 = 0, vwap15_30 = 0;
    try {
      // For VWAP we need volume data — use stocks directly, skip for indices if subscription missing
      const vwapContract = usesSPYVwap ? contracts.SPY : usesIWMVwap ? contracts.IWM : mainContract;
      const vwapWhat = (vwapContract.secType === SecType.IND) ? WhatToShow.BID_ASK : WhatToShow.TRADES;
      const vwapBars = await getHistoricalBars(vwapContract, '1 D', BarSizeSetting.MINUTES_FIVE, vwapWhat);
      if (vwapBars.length > 0) {
        const todayBars = vwapBars;
        const vwaps = calcVWAP(todayBars);

        vwap5 = vwaps.length > 0 ? vwaps[vwaps.length - 1] : 0;
        vwap5_30 = vwaps.length > 6 ? vwaps[vwaps.length - 7] : vwap5;
        vwap15 = vwap5;
        vwap15_30 = vwaps.length > 6 ? vwaps[vwaps.length - 7] : vwap5;

        // Derive price from last VWAP bar close if snapshot failed
        if (!finalPrice || finalPrice <= 0) {
          const lastVwapBar = todayBars[todayBars.length - 1];
          const vwapClose = lastVwapBar.close || 0;
          if (vwapClose > 0) {
            finalPrice = vwapClose;
            console.log('[BRIDGE] Price derived from VWAP bar close:', finalPrice);
          }
        }
        // Derive high/low from today's VWAP bars
        if (!finalHigh || finalHigh <= 0) {
          const highs = todayBars.map(b => b.high || 0).filter(v => v > 0);
          if (highs.length > 0) finalHigh = Math.max(...highs);
        }
        if (!finalLow || finalLow <= 0) {
          const lows = todayBars.map(b => b.low || 0).filter(v => v > 0);
          if (lows.length > 0) finalLow = Math.min(...lows);
        }
      }
    } catch (e) {
      console.error('[BRIDGE] VWAP calc error:', e.message);
    }

    // 6. Return all data
    const result = {
      underlying,
      price: Math.round(finalPrice * 100) / 100,
      high: Math.round(finalHigh * 100) / 100,
      low: Math.round(finalLow * 100) / 100,
      cashOpen: Math.round((derivedOpen || cashOpen) * 100) / 100,
      vix: Math.round(vix * 100) / 100,
      vix1d: Math.round(vix1d * 100) / 100,
      em: Math.round(em * 10) / 10,
      atr: Math.round(atr1d * 100) / 100,
      atr5: Math.round(atr5m * 100) / 100,
      atr2h: Math.round(atr2h * 100) / 100,
      // VWAP (SPY values for SPX — engine handles x10 scaling)
      vwap5: Math.round(vwap5 * 100) / 100,
      vwap5_30: Math.round(vwap5_30 * 100) / 100,
      vwap15: Math.round(vwap15 * 100) / 100,
      vwap15_30: Math.round(vwap15_30 * 100) / 100,
      // ES overnight
      esClose: Math.round(esClose * 100) / 100,
      priorDayClose: Math.round(esPrevClose * 100) / 100,
      esOvernightHigh: Math.round(esHigh * 100) / 100,
      esOvernightLow: Math.round(esLow * 100) / 100,
      esEM: Math.round(esEM * 10) / 10,
      // Meta
      timestamp: new Date().toISOString(),
      source: 'IBKR TWS',
      spyVwap: usesSPYVwap
    };

    console.log(`[BRIDGE] ${underlying}: price=${result.price} vix=${result.vix} em=${result.em} atr=${result.atr}`);
    res.json(result);
  } catch (err) {
    console.error('[BRIDGE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, connected, timestamp: new Date().toISOString() });
});

// ── Fetch model Greeks for one or more option legs ──
// GET /api/option-greeks?underlying=SPX&expiry=YYYYMMDD&strike=7480&right=C
// For multi-leg positions, pass legs as JSON: ?legs=[{strike,right},...]
// Returns single-leg greeks, and (if multiple legs) net position greeks.
app.get('/api/option-greeks', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });
    const underlying = (req.query.underlying || 'SPX').toUpperCase();
    const expiry = req.query.expiry; // YYYYMMDD
    if (!expiry) return res.status(400).json({ error: 'expiry (YYYYMMDD) required' });

    // Parse legs: either a single strike/right, or a legs=[...] array with qty.
    let legs;
    if (req.query.legs) {
      legs = JSON.parse(req.query.legs); // [{ strike, right, qty }]
    } else {
      legs = [{ strike: Number(req.query.strike), right: req.query.right || 'C', qty: 1 }];
    }

    const results = [];
    let anyNotSubscribed = false;
    for (const leg of legs) {
      const contract = buildOptionContract(underlying, expiry, leg.strike, leg.right);
      const g = await getOptionGreeks(contract);
      if (g && g.notSubscribed) { anyNotSubscribed = true; results.push({ strike: leg.strike, right: leg.right, qty: leg.qty || 1, greeks: null }); }
      else results.push({ strike: leg.strike, right: leg.right, qty: leg.qty || 1, greeks: g });
    }

    // Net position greeks (sum of qty × per-contract greek). For a butterfly the
    // engine mainly wants |delta|, theta, gamma of the whole structure.
    const net = { delta: 0, gamma: 0, theta: 0, vega: 0 };
    let haveAny = false;
    for (const r of results) {
      if (!r.greeks) continue;
      haveAny = true;
      const q = r.qty || 1;
      net.delta += (r.greeks.delta || 0) * q * 100; // ×100 → position dollars per $1 move
      net.gamma += (r.greeks.gamma || 0) * q * 100;
      net.theta += (r.greeks.theta || 0) * q * 100; // per-day position theta ($)
      net.vega  += (r.greeks.vega  || 0) * q * 100;
    }
    // Deliver theta as a positive daily-decay magnitude (engine convention).
    const netOut = haveAny ? {
      delta: +net.delta.toFixed(2),
      gamma: +net.gamma.toFixed(2),
      theta: +Math.abs(net.theta).toFixed(2),
      vega: +net.vega.toFixed(2)
    } : null;

    res.json({ underlying, expiry, legs: results, net: netOut,
      notSubscribed: anyNotSubscribed && !netOut,
      message: (anyNotSubscribed && !netOut)
        ? 'TWS returned no Greeks — your IBKR account is not subscribed to options market data for ' + underlying + '. Enable the OPRA / US options data subscription in IBKR Account Management, or enter Greeks manually.'
        : undefined });
  } catch (err) {
    console.log('[BRIDGE] option-greeks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Fetch today's executions (fills) from TWS ──
app.get('/api/executions', async (req, res) => {
  if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });

  const reqId = nextReqId++;
  const executions = [];
  const commissions = {};

  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ib.removeListener(EventName.execDetails, onExec);
        ib.removeListener(EventName.execDetailsEnd, onEnd);
        ib.removeListener(EventName.commissionReport, onComm);
        resolve(executions);
      }, 10000);

      function onExec(rId, contract, execution) {
        if (rId !== reqId) return;
        executions.push({
          execId: execution.execId,
          time: execution.time,
          account: execution.acctNumber,
          symbol: contract.symbol,
          secType: contract.secType,
          exchange: contract.exchange,
          side: execution.side, // BOT or SLD
          qty: execution.shares || execution.filledQuantity,
          price: execution.price,
          avgPrice: execution.avgPrice,
          orderId: execution.orderId,
          orderRef: execution.orderRef || '',
          // Option details
          strike: contract.strike || 0,
          right: contract.right || '', // C or P
          expiry: contract.lastTradeDateOrContractMonth || '',
          multiplier: contract.multiplier || '100',
          realizedPnl: execution.realizedPNL || 0
        });
      }

      function onComm(report) {
        if (report.execId) {
          commissions[report.execId] = {
            commission: report.commission,
            realizedPnl: report.realizedPNL,
            yield: report.yield
          };
        }
      }

      function onEnd(rId) {
        if (rId !== reqId) return;
        clearTimeout(timeout);
        ib.removeListener(EventName.execDetails, onExec);
        ib.removeListener(EventName.execDetailsEnd, onEnd);
        // Wait a moment for commission reports to arrive
        setTimeout(() => {
          ib.removeListener(EventName.commissionReport, onComm);
          resolve(executions);
        }, 1000);
      }

      ib.on(EventName.execDetails, onExec);
      ib.on(EventName.execDetailsEnd, onEnd);
      ib.on(EventName.commissionReport, onComm);

      // Request executions — empty filter gets all for today
      // Request executions — empty filter gets all for today
      const today = new Date();
      const timeStr = today.getFullYear() + ('0'+(today.getMonth()+1)).slice(-2) + ('0'+today.getDate()).slice(-2) + '-00:00:00';
      const filter = { clientId: 0, acctCode: '', time: timeStr, symbol: '', secType: '', exchange: '', side: '' };
      ib.reqExecutions(reqId, filter);
    });

    // Merge commissions with executions
    const merged = executions.map(e => ({
      ...e,
      commission: commissions[e.execId]?.commission || 0,
      realizedPnl: commissions[e.execId]?.realizedPnl || e.realizedPnl || 0
    }));

    // Group by orderId to get net positions
    const orderGroups = {};
    merged.forEach(e => {
      const key = e.orderId || e.execId;
      if (!orderGroups[key]) orderGroups[key] = { fills: [], symbol: e.symbol, side: e.side, totalQty: 0, totalCommission: 0, realizedPnl: 0 };
      orderGroups[key].fills.push(e);
      orderGroups[key].totalQty += e.qty;
      orderGroups[key].totalCommission += e.commission;
      if (e.realizedPnl && e.realizedPnl !== 1.7976931348623157e+308) {
        orderGroups[key].realizedPnl += e.realizedPnl;
      }
    });

    console.log(`[BRIDGE] Executions: ${merged.length} fills, ${Object.keys(orderGroups).length} orders`);
    res.json({
      fills: merged,
      orders: Object.values(orderGroups),
      count: merged.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[BRIDGE] Executions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect
app.post('/api/disconnect', (req, res) => {
  if (ib) { ib.disconnect(); connected = false; }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[BRIDGE] IB Bridge running on http://localhost:${PORT}`);
  console.log(`[BRIDGE] Connecting to TWS at ${TWS_HOST}:${TWS_PORT}...`);
  connectTWS().catch(e => console.error('[BRIDGE] Initial connect failed:', e.message));
});

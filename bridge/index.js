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

// ── Request historical bars ──
function getHistoricalBars(contract, duration, barSize, whatToShow = WhatToShow.TRADES) {
  return new Promise((resolve, reject) => {
    const reqId = getReqId();
    const bars = [];
    let resolved = false;

    const onBar = (id, bar) => {
      if (id !== reqId) return;
      bars.push(bar);
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
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    if (h > 0 && l > 0 && pc > 0) {
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  if (trs.length === 0) return 0;
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((s, v) => s + v, 0) / n;
}

// ── Calculate VWAP from bars (bars must have volume) ──
function calcVWAP(bars) {
  let cumVP = 0, cumV = 0;
  const vwaps = [];
  bars.forEach(b => {
    const typical = (b.high + b.low + b.close) / 3;
    cumVP += typical * (b.volume || 0);
    cumV += (b.volume || 0);
    vwaps.push(cumV > 0 ? cumVP / cumV : b.close);
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

    const price = mainSnap.mid || mainSnap.last || 0;
    const high = mainSnap.high || 0;
    const low = mainSnap.low || 0;
    const cashOpen = mainSnap.open || 0;
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
    // For SPX (index), use SPY for historical bars (SPX has no trade data)
    const histContract = (underlying === 'SPX') ? contracts.SPY : mainContract;
    const [bars1D, bars5m, bars2h] = await Promise.all([
      getHistoricalBars(histContract, '20 D', BarSizeSetting.DAYS_ONE).catch(e => { console.log('[BRIDGE] bars1D error:', e.message); return []; }),
      getHistoricalBars(histContract, '1 D', BarSizeSetting.MINUTES_FIVE).catch(e => { console.log('[BRIDGE] bars5m error:', e.message); return []; }),
      getHistoricalBars(histContract, '5 D', BarSizeSetting.HOURS_TWO).catch(e => { console.log('[BRIDGE] bars2h error:', e.message); return []; })
    ]);

    const atr1d = calcATR(bars1D, 14);
    const atr5m = calcATR(bars5m, 14);
    const atr2h = calcATR(bars2h, 14);

    // 4. VWAP from 5-min bars (use SPY for SPX)
    let vwap5 = 0, vwap5_30 = 0, vwap15 = 0, vwap15_30 = 0;
    try {
      const vwapBars = await getHistoricalBars(vwapContract, '1 D', BarSizeSetting.MINUTES_FIVE, WhatToShow.TRADES);
      if (vwapBars.length > 0) {
        // Filter to today's session only (after 9:30 ET)
        const todayBars = vwapBars; // IBKR returns current session
        const vwaps = calcVWAP(todayBars);

        // Current VWAP = last value
        vwap5 = vwaps.length > 0 ? vwaps[vwaps.length - 1] : 0;
        // VWAP 30 min ago = 6 bars back on 5-min chart
        vwap5_30 = vwaps.length > 6 ? vwaps[vwaps.length - 7] : vwap5;

        // 15-min VWAP: take every 3rd bar's VWAP value
        vwap15 = vwap5; // current is same
        vwap15_30 = vwaps.length > 6 ? vwaps[vwaps.length - 7] : vwap5;
      }
    } catch (e) {
      console.error('[BRIDGE] VWAP calc error:', e.message);
    }

    // 5. Return all data
    const result = {
      underlying,
      price: Math.round(price * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      cashOpen: Math.round(cashOpen * 100) / 100,
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

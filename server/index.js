import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initAuth, getAuthUrl, handleAuthCallback, setTokens,
  ensureSheetStructure, getConfig, updateConfig,
  appendTrades, getTrades, clearTrades,
  writeTradeTracker, getTradeTracker,
  logDecision, getDecisions,
  getBattingAverage, updateBattingAverage,
  appendJournalEntry, getJournal,
  calculateStats,
  updateTrackerStrategy, updateTradesStrategy,
  closeTradeTicket, updateTradeNotes, updateTradeStatus
} from './sheets.js';
import { parseCSV, processCSV } from './csvParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Serve static React build in production
app.use(express.static(path.join(__dirname, '../client/dist')));

// ================================================================
//  AUTH ROUTES
// ================================================================
const auth = initAuth({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI
});

// In-memory token store (use a DB in production)
let storedTokens = null;

app.get('/auth/google', (req, res) => {
  res.json({ url: getAuthUrl() });
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const tokens = await handleAuthCallback(req.query.code);
    storedTokens = tokens;
    await ensureSheetStructure();
    // Redirect to frontend
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}?auth=success`);
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:5173'}?auth=error`);
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!storedTokens });
});

// Middleware to check auth
function requireAuth(req, res, next) {
  if (!storedTokens) return res.status(401).json({ error: 'Not authenticated' });
  setTokens(storedTokens);
  next();
}

// ================================================================
//  CONFIG
// ================================================================
app.get('/api/config', requireAuth, async (req, res) => {
  try {
    const config = await getConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config/:key', requireAuth, async (req, res) => {
  try {
    await updateConfig(req.params.key, req.body.value);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  CSV UPLOAD + PROCESSING
// ================================================================
app.post('/api/upload-csv', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const text = req.file.buffer.toString('utf-8');
    const rawRows = parseCSV(text);

    if (!rawRows.length) return res.status(400).json({ error: 'Empty or invalid CSV' });

    // Process into cleaned trades + trade tracker
    const { outputRows, trackerRows } = processCSV(rawRows);

    // Write to Google Sheet
    await clearTrades();
    const tradesWritten = await appendTrades(outputRows);
    const trackerWritten = await writeTradeTracker(trackerRows);

    // Calculate and update stats
    const stats = calculateStats([['header'], ...trackerRows]);
    await updateBattingAverage(stats);

    // Update journal entries
    const dateMap = {};
    trackerRows.forEach(row => {
      const date = row[1]; // entry date
      if (!date) return;
      const d = date.split('T')[0];
      if (!dateMap[d]) dateMap[d] = { pnl: 0, count: 0, wins: 0, losses: 0 };
      dateMap[d].pnl += parseFloat(row[8]) || 0;
      dateMap[d].count++;
      if (row[9] === 'Win') dateMap[d].wins++;
      if (row[9] === 'Loss') dateMap[d].losses++;
    });

    for (const [date, data] of Object.entries(dateMap)) {
      const d = new Date(date);
      const weekNum = Math.ceil((d.getDate()) / 7);
      await appendJournalEntry({
        date,
        dayPnl: Math.round(data.pnl * 100) / 100,
        tradesCount: data.count,
        winCount: data.wins,
        lossCount: data.losses,
        weekNumber: `W${weekNum}`
      });
    }

    res.json({
      ok: true,
      rawRows: rawRows.length,
      tradesWritten,
      trackerWritten,
      stats
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  TRADES
// ================================================================
app.get('/api/trades', requireAuth, async (req, res) => {
  try {
    const rows = await getTrades();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  TRADE TRACKER
// ================================================================
app.get('/api/tracker', requireAuth, async (req, res) => {
  try {
    const rows = await getTradeTracker();
    // Parse into objects for frontend
    const headers = rows[0] || [];
    const data = rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  STATS / BATTING AVERAGE
// ================================================================
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    // Calculate stats fresh from TradeTracker data (not BattingAverage sheet)
    // This ensures accuracy regardless of sheet formula state
    const trackerRows = await getTradeTracker();
    const stats = calculateStats(trackerRows);
    const config = await getConfig();
    res.json({ stats, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  DECISIONS
// ================================================================
app.post('/api/decisions', requireAuth, async (req, res) => {
  try {
    const row = await logDecision(req.body);
    res.json({ ok: true, row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/decisions', requireAuth, async (req, res) => {
  try {
    const rows = await getDecisions();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  JOURNAL
// ================================================================
app.get('/api/journal', requireAuth, async (req, res) => {
  try {
    const rows = await getJournal();
    const headers = rows[0] || [];
    const data = rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/journal', requireAuth, async (req, res) => {
  try {
    await appendJournalEntry(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  DECISION ↔ TRADE COMPARISON
//  Matches logged decision engine entries to actual tastytrade trades
//  by underlying + date (±1 day) + strategy similarity.
// ================================================================
app.get('/api/comparison', requireAuth, async (req, res) => {
  try {
    const [decisionRows, trackerRows] = await Promise.all([
      getDecisions(),
      getTradeTracker()
    ]);

    const decHeaders = decisionRows[0] || [];
    const decisions = decisionRows.slice(1).map(row => {
      const obj = {};
      decHeaders.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });

    const trkHeaders = trackerRows[0] || [];
    const trades = trackerRows.slice(1).map(row => {
      const obj = {};
      trkHeaders.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });

    // Normalise strategy names for fuzzy matching
    function normStrat(s) {
      return (s || '').toLowerCase()
        .replace(/iron condor.*normal/i, 'iron condor')
        .replace(/long.*condor.*reversed/i, 'long condor')
        .replace(/short iron condor/i, 'iron condor')
        .replace(/long iron condor/i, 'long condor')
        .replace(/short iron butterfly/i, 'iron butterfly')
        .replace(/long call butterfly/i, 'butterfly')
        .replace(/long put butterfly/i, 'butterfly')
        .replace(/short call butterfly/i, 'butterfly')
        .replace(/bull put spread/i, 'bull put')
        .replace(/bear call spread/i, 'bear call')
        .replace(/bull call spread/i, 'bull call')
        .replace(/bear put spread/i, 'bear put')
        .replace(/[^a-z ]/g, '').trim();
    }

    // Match each decision to the best trade
    const matches = decisions.map(dec => {
      const decDate = dec.Timestamp ? new Date(dec.Timestamp) : null;
      const decUnd = (dec.Underlying || '').toUpperCase();
      const decStrat = normStrat(dec.Strategy);
      // Extract the actual strategy name from the decision text (e.g. "SPX - Iron Condor - Normal - 2 contracts")
      const stratParts = (dec.Strategy || '').split(' - ').map(s => s.trim());
      const decStratClean = normStrat(stratParts.length > 1 ? stratParts.slice(1, -1).join(' ') : dec.Strategy);

      let bestMatch = null;
      let bestScore = 0;

      trades.forEach(trade => {
        const tradeDate = trade['Entry Date'] ? new Date(trade['Entry Date']) : null;
        const tradeUnd = (trade.Underlying || '').toUpperCase();
        const tradeStrat = normStrat(trade['Strategy (OIC)']);

        // Score the match
        let score = 0;

        // Underlying must match
        if (decUnd && tradeUnd && decUnd === tradeUnd) score += 40;
        else return;

        // Date within ±1 day
        if (decDate && tradeDate) {
          const dayDiff = Math.abs(decDate - tradeDate) / (1000 * 60 * 60 * 24);
          if (dayDiff < 1) score += 40;
          else if (dayDiff < 2) score += 25;
          else if (dayDiff < 3) score += 10;
          else return; // too far apart
        }

        // Strategy similarity
        if (decStratClean && tradeStrat) {
          if (decStratClean === tradeStrat) score += 20;
          else if (decStratClean.includes(tradeStrat) || tradeStrat.includes(decStratClean)) score += 12;
          else {
            // Check for partial word matches
            const decWords = decStratClean.split(' ');
            const tradeWords = tradeStrat.split(' ');
            const overlap = decWords.filter(w => tradeWords.includes(w)).length;
            score += overlap * 4;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = trade;
        }
      });

      return {
        decision: {
          timestamp: dec.Timestamp,
          engine: dec.Engine,
          underlying: dec.Underlying,
          strategy: dec.Strategy,
          direction: dec.Direction,
          contracts: dec.Contracts,
          kellyDollar: dec['Kelly $'],
          popMargin: dec['POP Margin'],
          setupScore: dec['Setup Score'],
          setupGrade: dec['Setup Grade'],
          regime: dec.Regime,
          notes: dec.Notes,
          price: dec.Price,
          vix: dec.VIX
        },
        matchedTrade: bestMatch ? {
          entryDate: bestMatch['Entry Date'],
          underlying: bestMatch.Underlying,
          strategy: bestMatch['Strategy (OIC)'],
          qty: bestMatch.Qty,
          netCredit: parseFloat(bestMatch['Net Credit ($)']) || 0,
          totalPnl: parseFloat(bestMatch['Total P&L ($)']) || 0,
          wl: bestMatch['W / L'],
          status: bestMatch.Status
        } : null,
        matchScore: bestScore,
        matched: bestScore >= 60
      };
    });

    // Summary stats
    const matched = matches.filter(m => m.matched);
    const engineWins = matched.filter(m => m.decision.direction === 'Trade' && m.matchedTrade?.wl === 'Win').length;
    const engineTotal = matched.filter(m => m.decision.direction === 'Trade' && m.matchedTrade?.wl).length;
    const totalEngPnl = matched.reduce((s, m) => s + (m.matchedTrade?.totalPnl || 0), 0);

    res.json({
      matches,
      summary: {
        totalDecisions: decisions.length,
        totalMatched: matched.length,
        engineAccuracy: engineTotal > 0 ? Math.round(engineWins / engineTotal * 100) : 0,
        enginePnl: Math.round(totalEngPnl * 100) / 100
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  STRATEGY PERFORMANCE (computed from tracker)
// ================================================================
app.get('/api/performance', requireAuth, async (req, res) => {
  try {
    const rows = await getTradeTracker();
    const data = rows.slice(1);
    if (!data.length) return res.json({ byStrategy: {}, byUnderlying: {}, overall: {} });

    const byStrategy = {};
    const byUnderlying = {};

    data.forEach(row => {
      const strategy = row[4] || 'Unknown';
      const underlying = row[5] || 'Unknown';
      const pnl = parseFloat(row[8]) || 0;
      const wl = row[9];

      // By strategy
      if (!byStrategy[strategy]) byStrategy[strategy] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
      if (wl) {
        byStrategy[strategy].trades++;
        if (wl === 'Win') byStrategy[strategy].wins++;
        if (wl === 'Loss') byStrategy[strategy].losses++;
        byStrategy[strategy].pnl += pnl;
      }

      // By underlying
      if (!byUnderlying[underlying]) byUnderlying[underlying] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
      if (wl) {
        byUnderlying[underlying].trades++;
        if (wl === 'Win') byUnderlying[underlying].wins++;
        if (wl === 'Loss') byUnderlying[underlying].losses++;
        byUnderlying[underlying].pnl += pnl;
      }
    });

    // Calculate batting averages
    Object.values(byStrategy).forEach(s => {
      s.ba = s.trades > 0 ? Math.round(s.wins / s.trades * 1000) / 10 : 0;
      s.pnl = Math.round(s.pnl * 100) / 100;
    });
    Object.values(byUnderlying).forEach(u => {
      u.ba = u.trades > 0 ? Math.round(u.wins / u.trades * 1000) / 10 : 0;
      u.pnl = Math.round(u.pnl * 100) / 100;
    });

    const overall = calculateStats(rows);
    res.json({ byStrategy, byUnderlying, overall });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  TRADE TICKET LIFECYCLE
// ================================================================
app.put('/api/decisions/:rowIndex/close', requireAuth, async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    const { closeDate, closePrice, actualPnl } = req.body;
    await closeTradeTicket(rowIndex, { closeDate, closePrice, actualPnl });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/decisions/:rowIndex/notes', requireAuth, async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    const { notes } = req.body;
    await updateTradeNotes(rowIndex, notes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/decisions/:rowIndex/status', requireAuth, async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    const { status } = req.body;
    await updateTradeStatus(rowIndex, status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  UNKNOWN TRADE CATEGORISATION
//  Returns trades with empty or unclassified strategies for manual review.
//  Allows updating strategy via PUT.
// ================================================================
app.get('/api/uncategorised', requireAuth, async (req, res) => {
  try {
    const rows = await getTradeTracker();
    const headers = rows[0] || [];
    const data = rows.slice(1).map((row, idx) => {
      const obj = { _rowIndex: idx + 2 }; // 1-based sheet row (header=1, data starts at 2)
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });
    // Filter to uncategorised: empty strategy, or generic single-leg names
    const uncategorised = data.filter(t => {
      const strat = (t['Strategy (OIC)'] || '').trim();
      return !strat ||
        strat === 'Long Call' || strat === 'Long Put' ||
        strat === 'Naked Call' || strat === 'Naked Put' ||
        strat === 'Short Stock' || strat === 'Long Stock';
    });
    res.json(uncategorised);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/categorise/:rowIndex', requireAuth, async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    const { strategy, orderId } = req.body;
    if (!strategy || !rowIndex) return res.status(400).json({ error: 'Missing strategy or rowIndex' });

    // Update TradeTracker sheet
    await updateTrackerStrategy(rowIndex, strategy);

    // Also update matching rows in raw Trades sheet
    let tradesUpdated = 0;
    if (orderId) {
      tradesUpdated = await updateTradesStrategy(orderId, strategy);
    }

    res.json({ ok: true, tradesUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  SPA FALLBACK
// ================================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Options Tracker server running on port ${PORT}`);
});

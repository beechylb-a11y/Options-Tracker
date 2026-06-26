import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initAuth, getAuthUrl, handleAuthCallback, setTokens,
  ensureSheetStructure, getConfig, updateConfig, getAccounts, saveAccounts, backfillAccountColumn,
  appendTrades, getTrades, clearTrades,
  writeTradeTracker, getTradeTracker, appendTradeTrackerRow,
  updateTradeTrackerRow, deleteTradeTrackerRow,
  logDecision, getDecisions,
  getBattingAverage, updateBattingAverage,
  appendJournalEntry, getJournal,
  calculateStats,
  updateTrackerStrategy, updateTradesStrategy,
  closeTradeTicket, updateTradeNotes, updateTradeStatus,
  uploadDocument, listDocuments, deleteDocument, getDocumentUrl,
  scanTastyTradeEmails
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

// Persistent token store — saves to Config sheet so tokens survive restarts
let storedTokens = null;

// Try to load tokens from environment variable (set in Railway)
if (process.env.GOOGLE_TOKENS) {
  try {
    storedTokens = JSON.parse(process.env.GOOGLE_TOKENS);
    setTokens(storedTokens);
    console.log('[AUTH] Loaded tokens from environment, refresh_token:', !!storedTokens.refresh_token);
    // Verify connection and ensure sheet structure
    ensureSheetStructure()
      .then(() => console.log('[AUTH] Sheet connection verified'))
      .catch(e => console.error('[AUTH] Sheet connection failed:', e.message));
  } catch (e) {
    console.log('[AUTH] Failed to parse GOOGLE_TOKENS env:', e.message);
  }
}

app.get('/auth/google', (req, res) => {
  res.json({ url: getAuthUrl() });
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const tokens = await handleAuthCallback(req.query.code);
    storedTokens = tokens;
    console.log('[AUTH] Tokens received, refresh_token:', !!tokens.refresh_token);
    await ensureSheetStructure();
    // Save tokens to Config sheet for persistence
    try {
      await saveTokensToConfig(tokens);
    } catch (e) {
      console.log('[AUTH] Could not save tokens to config:', e.message);
    }
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}?auth=success`);
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:5173'}?auth=error`);
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!storedTokens, sheetId: process.env.SPREADSHEET_ID || '' });
});

// Auto-load tokens from Config sheet on startup
async function loadTokensFromConfig() {
  try {
    if (storedTokens) return; // already loaded from env
    const { google } = await import('googleapis');
    // Can't read Config without auth — need env var for bootstrap
    console.log('[AUTH] No tokens in memory. Set GOOGLE_TOKENS env var in Railway or sign in via the app.');
  } catch (e) {
    console.log('[AUTH] Token load failed:', e.message);
  }
}

async function saveTokensToConfig(tokens) {
  // Store as JSON in Config sheet for future reference
  // But primary persistence is the GOOGLE_TOKENS env var in Railway
  console.log('[AUTH] Tokens to persist (copy to Railway GOOGLE_TOKENS env var):');
  console.log(JSON.stringify(tokens));
}

loadTokensFromConfig();

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
//  ACCOUNTS
// ================================================================
app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await getAccounts();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/accounts', requireAuth, async (req, res) => {
  try {
    await saveAccounts(req.body.accounts);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/accounts/backfill', requireAuth, async (req, res) => {
  try {
    const accountId = req.body.accountId;
    if (!accountId) return res.status(400).json({ error: 'No accountId provided' });
    const updated = await backfillAccountColumn(accountId, req.body.force || false);
    res.json({ ok: true, updated });
  } catch (err) {
    console.error('Backfill error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  CSV UPLOAD + PROCESSING
// ================================================================
app.post('/api/upload-csv', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const account = req.body?.account || '';

    const text = req.file.buffer.toString('utf-8');
    const rawRows = parseCSV(text);

    if (!rawRows.length) return res.status(400).json({ error: 'Empty or invalid CSV' });

    // Process into cleaned trades + trade tracker
    const { outputRows, trackerRows } = processCSV(rawRows);

    // Tag each tracker row with account
    const taggedRows = trackerRows.map(row => {
      const r = [...row];
      while (r.length < 13) r.push('');
      r[12] = account;
      return r;
    });

    // Write to Google Sheet
    await clearTrades();
    const tradesWritten = await appendTrades(outputRows);
    const trackerWritten = await writeTradeTracker(taggedRows);

    // Calculate and update stats
    const stats = calculateStats([['header'], ...trackerRows]);
    await updateBattingAverage(stats);

    // Journal no longer populated from CSV — all P&L data is derived from TradeTracker
    // Journal sheet is now only for user-written daily review notes

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
//  CSV COMPARE — compare fresh TastyTrade CSV against TradeTracker
// ================================================================
app.post('/api/compare-csv', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const text = req.file.buffer.toString('utf-8');
    const rawRows = parseCSV(text);
    const { trackerRows } = processCSV(rawRows);

    // Get existing TradeTracker data
    const existing = await getTradeTracker();
    const headers = existing[0] || [];
    const existingTrades = existing.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });

    // Compare: match CSV trades to existing by underlying + close date + strategy
    const csvTrades = trackerRows.map(row => ({
      orderId: row[0], entryDate: (row[1] || '').split('T')[0],
      expiryDate: (row[2] || '').split('T')[0], closeDate: (row[3] || '').split('T')[0],
      strategy: row[4], underlying: row[5], qty: parseInt(row[6]) || 0,
      netCredit: parseFloat(row[7]) || 0, totalPnl: parseFloat(row[8]) || 0,
      wl: row[9], status: row[11]
    }));

    const results = [];
    const matchedExisting = new Set();

    csvTrades.forEach(csv => {
      // Find best match in existing
      let bestMatch = null, bestScore = 0;
      existingTrades.forEach((ex, idx) => {
        if (matchedExisting.has(idx)) return;
        let score = 0;
        if (ex.Underlying === csv.underlying) score += 3;
        const exEntry = (ex['Entry Date'] || '').split('T')[0];
        const exClose = (ex['Close Date'] || '').split('T')[0];
        if (exEntry === csv.entryDate) score += 2;
        if (exClose === csv.closeDate) score += 2;
        if (ex['Strategy (OIC)'] === csv.strategy) score += 2;
        const exPnl = parseFloat(ex['Total P&L ($)']) || 0;
        if (Math.abs(exPnl - csv.totalPnl) < 1) score += 3;
        else if (Math.abs(exPnl - csv.totalPnl) < 10) score += 1;
        if (score >= 5 && score > bestScore) { bestMatch = { ...ex, _idx: idx }; bestScore = score; }
      });

      if (bestMatch) {
        matchedExisting.add(bestMatch._idx);
        const exPnl = parseFloat(bestMatch['Total P&L ($)']) || 0;
        const pnlDiff = csv.totalPnl - exPnl;
        const hasDiff = Math.abs(pnlDiff) >= 1 || bestMatch['Strategy (OIC)'] !== csv.strategy || bestMatch.Status !== csv.status;
        results.push({
          status: hasDiff ? 'mismatch' : 'match',
          csv, existing: bestMatch, pnlDiff: Math.round(pnlDiff * 100) / 100,
          diffs: hasDiff ? {
            pnl: Math.abs(pnlDiff) >= 1 ? { csv: csv.totalPnl, existing: exPnl } : null,
            strategy: bestMatch['Strategy (OIC)'] !== csv.strategy ? { csv: csv.strategy, existing: bestMatch['Strategy (OIC)'] } : null,
            status: bestMatch.Status !== csv.status ? { csv: csv.status, existing: bestMatch.Status } : null
          } : null
        });
      } else {
        results.push({ status: 'csv_only', csv, existing: null, pnlDiff: 0, diffs: null });
      }
    });

    // Find tracker-only trades (in existing but not in CSV)
    existingTrades.forEach((ex, idx) => {
      if (!matchedExisting.has(idx)) {
        results.push({
          status: 'tracker_only',
          csv: null,
          existing: ex,
          pnlDiff: 0, diffs: null
        });
      }
    });

    const summary = {
      total: results.length,
      matched: results.filter(r => r.status === 'match').length,
      mismatched: results.filter(r => r.status === 'mismatch').length,
      csvOnly: results.filter(r => r.status === 'csv_only').length,
      trackerOnly: results.filter(r => r.status === 'tracker_only').length,
      totalPnlDiff: Math.round(results.reduce((s, r) => s + (r.pnlDiff || 0), 0) * 100) / 100
    };

    res.json({ results, summary });
  } catch (err) {
    console.error('Compare error:', err);
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
    const data = rows.slice(1).map((row, idx) => {
      const obj = { _rowIndex: idx + 2 };
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  TRADE EDIT / DELETE
// ================================================================
app.put('/api/tracker/:rowIndex', requireAuth, async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    if (isNaN(rowIndex) || rowIndex < 2) return res.status(400).json({ error: 'Invalid row index' });
    await updateTradeTrackerRow(rowIndex, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tracker/:rowIndex', requireAuth, async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    if (isNaN(rowIndex) || rowIndex < 2) return res.status(400).json({ error: 'Invalid row index' });
    await deleteTradeTrackerRow(rowIndex);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  STATS / BATTING AVERAGE
// ================================================================
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const trackerRows = await getTradeTracker();
    const account = req.query.account;
    let filtered = trackerRows;
    if (account && account !== 'all') {
      const headers = trackerRows[0] || [];
      filtered = [headers, ...trackerRows.slice(1).filter(row => (row[12] || '') === account)];
    }
    const stats = calculateStats(filtered);
    const config = await getConfig();
    // If account selected, merge account-specific config
    const accounts = await getAccounts();
    const acct = accounts.find(a => a.id === account);
    if (acct) {
      config.currentBankroll = acct.bankroll;
      config.startingBankroll = acct.startingBankroll;
      config.maxDailyLoss = acct.maxDailyLoss;
      config.maxOpenRisk = acct.maxOpenRisk;
    }
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
    const account = req.query.account;
    let data = rows.slice(1);
    if (account && account !== 'all') {
      data = data.filter(row => (row[12] || '') === account);
    }
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
    if (isNaN(rowIndex) || rowIndex < 2) return res.status(400).json({ error: 'Invalid row index' });
    const { closeDate, closePrice, actualPnl } = req.body;

    // 0. Check if already closed (prevent duplicate writes)
    const decRowsPre = await getDecisions();
    const headersPre = decRowsPre[0] || [];
    const statusIdx = headersPre.indexOf('Status');
    const existingRow = decRowsPre[rowIndex - 1];
    if (existingRow && statusIdx >= 0 && existingRow[statusIdx] === 'Closed') {
      return res.json({ ok: true, note: 'Already closed' });
    }

    // 1. Update the Decisions sheet
    await closeTradeTicket(rowIndex, { closeDate, closePrice, actualPnl });

    // 2. Get the decision row to extract details for TradeTracker + Journal
    const decRows = await getDecisions();
    const headers = decRows[0] || [];
    const row = decRows[rowIndex - 1];
    const dec = {};
    if (row) headers.forEach((h, i) => { dec[h] = row[i] || ''; });

    const pnl = parseFloat(actualPnl) || 0;
    const isWin = pnl >= 0;
    const cDate = closeDate || new Date().toISOString().split('T')[0];
    const underlying = dec.Underlying || '';
    const strategy = dec.Strategy || '';
    // Extract strategy name from "SPX - Iron Condor - Normal - 1 contract"
    const stratParts = strategy.split(' - ');
    const stratName = stratParts.length > 2 ? stratParts.slice(1, -1).join(' - ') : strategy;
    const contracts = parseInt(dec.Contracts) || 1;

    // 3. Append to TradeTracker so it shows in Dashboard/Summary/Analytics
    const trackerRow = [
      `TICKET-${rowIndex}`,       // Order #
      dec.Timestamp ? dec.Timestamp.split('T')[0] : cDate, // Entry Date
      '',                          // Expiry Date
      cDate,                       // Close Date
      stratName,                   // Strategy (OIC)
      underlying,                  // Underlying
      contracts,                   // Qty
      '',                          // Net Credit ($)
      pnl,                         // Total P&L ($)
      isWin ? 'Win' : 'Loss',     // W / L
      '',                          // Cumul BA (%)
      'Closed',                    // Status
      req.body.account || ''       // Account
    ];
    await appendTradeTrackerRow(trackerRow);

    // Journal no longer populated from close ticket — P&L derived from TradeTracker

    console.log(`[CLOSE TICKET] rowIndex=${rowIndex}, statusAfterClose=${dec.Status}, rowLen=${row?.length}, headerLen=${headers.length}, statusIdx=${headers.indexOf('Status')}`);
    res.json({ ok: true, debug: { rowIndex, statusAfterClose: dec.Status, rowLen: row?.length, headerLen: headers.length } });
  } catch (err) {
    console.error('[CLOSE TICKET ERROR]', err);
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
//  DOCUMENTS
// ================================================================
app.post('/api/documents', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const meta = {
      type: req.body.type || 'other',
      tradeDate: req.body.tradeDate || '',
      underlying: req.body.underlying || '',
      notes: req.body.notes || '',
      uploadedAt: new Date().toISOString()
    };
    const result = await uploadDocument(req.file.buffer, req.file.originalname, req.file.mimetype, meta);
    res.json({ ok: true, file: result });
  } catch (err) {
    console.error('Document upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/documents', requireAuth, async (req, res) => {
  try {
    const docs = await listDocuments();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/documents/:fileId', requireAuth, async (req, res) => {
  try {
    await deleteDocument(req.params.fileId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/documents/:fileId/url', requireAuth, async (req, res) => {
  try {
    const urls = await getDocumentUrl(req.params.fileId);
    res.json(urls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  GMAIL — TASTYTRADE EMAIL SCAN
// ================================================================
app.get('/api/gmail/scan', requireAuth, async (req, res) => {
  try {
    const maxResults = parseInt(req.query.max) || 50;
    const afterDate = req.query.after || null;
    const emails = await scanTastyTradeEmails(maxResults, afterDate);
    res.json({ emails, count: emails.length });
  } catch (err) {
    console.error('Gmail scan error:', err);
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

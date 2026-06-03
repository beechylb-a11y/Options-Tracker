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
  calculateStats
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
//  SPA FALLBACK
// ================================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Options Tracker server running on port ${PORT}`);
});

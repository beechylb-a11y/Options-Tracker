# Options Tracker

Full-stack options trading portfolio management and decision engine.

## Features

- **Dashboard** — KPI cards (Total P&L, ROI, BA, Avg Win/Loss, Expectancy), P&L chart, upcoming expiries
- **Trades** — CSV upload from TastyTrade, trade list with All/Open/Closed filters, expandable trade tickets
- **Decision Engine** — Embedded 0DTE + 45DTE pre-trade analysis engine
- **Journal** — Monthly calendar with daily P&L colour coding, weekly results
- **Summary** — Strategy performance breakdown, ROI by strategy/underlying, batting average
- **Settings** — Google OAuth connection, bankroll + risk configuration

## Tech Stack

- **Frontend:** React + Tailwind CSS + Recharts
- **Backend:** Node.js / Express
- **Data Store:** Google Sheets (via Google Sheets API)
- **Auth:** Google OAuth 2.0
- **Hosting:** Railway

## Setup

### 1. Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable **Google Sheets API** and **Google Drive API**
4. Go to Credentials → Create Credentials → OAuth 2.0 Client ID
5. Application type: Web application
6. Add authorized redirect URI: `https://your-railway-url.up.railway.app/auth/google/callback`
7. Copy the Client ID and Client Secret

### 2. Google Sheet

1. Create a new Google Sheet
2. Copy the Sheet ID from the URL (the part between `/d/` and `/edit`)
3. The app will auto-create required tabs on first connection

### 3. Railway Deployment

1. Push this repo to GitHub
2. Create a new Railway project → Deploy from GitHub
3. Set environment variables:

```
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret  
GOOGLE_REDIRECT_URI=https://your-app.up.railway.app/auth/google/callback
SPREADSHEET_ID=your_google_sheet_id
CLIENT_URL=https://your-app.up.railway.app
PORT=3001
```

4. Deploy

### 4. Connect

1. Open your Railway app URL
2. Go to Settings tab → Connect Google Account
3. Authorize access
4. The app auto-creates all required sheet tabs

## CSV Upload

Export your **Activity** history from TastyTrade (CSV format). Upload via the Trades tab. The app:

1. Parses the tab-delimited CSV
2. Groups legs by Order # and classifies multi-leg strategies  
3. Matches open/close legs using fingerprint queue (FIFO)
4. Calculates P&L per position
5. Writes to Google Sheet (Trades + TradeTracker tabs)
6. Updates batting average and journal entries

## Google Sheet Tabs

| Tab | Purpose |
|---|---|
| Config | Bankroll, risk parameters |
| Trades | Raw CSV legs (one row per leg) |
| TradeTracker | Grouped positions (one row per lifecycle) |
| Decisions | Decision engine outputs logged per session |
| BattingAverage | System-wide KPI metrics |
| Journal | Daily P&L entries for calendar view |

# IBKR TWS Bridge — Setup Guide

## What this does
Connects to your running TWS (Trader Workstation) and serves market data to the Options Tracker decision engine via a REST API. One click in the app auto-fills all engine inputs.

## Prerequisites
- Node.js 18+ installed
- TWS running and logged in
- Ngrok installed (`brew install ngrok` on Mac)

## TWS Configuration
1. Open TWS → Edit → Global Configuration → API → Settings
2. Check **Enable ActiveX and Socket Clients**
3. Set **Socket port** to `7496` (paper: `7497`)
4. Check **Allow connections from localhost only**
5. Uncheck **Read-Only API** (needed for market data)
6. Click OK and restart TWS

## Installation
```bash
cd bridge
npm install
```

## Running
```bash
# Terminal 1: Start the bridge
npm start

# Terminal 2: Expose via ngrok
ngrok http 3333
```

Ngrok will show a URL like `https://abc123.ngrok-free.app`. Copy this URL.

## Connect to Options Tracker
1. Go to Settings in the app
2. Paste the ngrok URL in the **IBKR Bridge URL** field
3. Click Save

Now the "Auto-fill" button in the Decision Engine will fetch all market data in one click.

## Bridge key and TWS capture (Nov 2026)
The bridge is reachable by anyone who knows the ngrok URL, so calls through ngrok now
need a key. Run once on the Mac:
```bash
cd bridge && bash setup-key.sh
```
It writes `BRIDGE_KEY` (and copies `DATABASE_URL` from server/.env) into `bridge/.env`,
restarts the bridge, installs the hourly TWS capture (`captureTws.js`, launchd job
`com.options-tracker.tws-capture`, log `/tmp/tws-capture.log`) and prints the key.
Paste the key into the app under Settings → IBKR Bridge → Bridge key.
Calls made directly on the Mac (`curl localhost:3333/...`) don't need the key.
The capture fills `options.tws_executions`, `options.tws_positions` and
`options.tws_capture_runs`, which the Saturday review reconciles against.

## Live book and push stream (Nov 2026)

The bridge keeps one set of always-on TWS subscriptions and pushes changes to the app
over a single stream, instead of opening a fresh request on every poll.

- **What streams:** the watched underlyings (`LIVE_WATCH`, default `SPX,XSP,SPY,QQQ,IWM,VIX,VIX1D`),
  every option leg you hold a position in (added and dropped as TWS reports positions), and the legs
  of a ticket open in the app (they expire 2 minutes after the app stops asking).
- **Data lines:** `LIVE_MAX_LINES` (default 60) caps the lines the live book uses, leaving the rest of
  your allowance to TWS's own windows. Positions and watched underlyings always get a line; ticket legs
  are refused when the budget is full (the app says so).
- **Endpoints:** `GET /api/stream` (Server-Sent Events: `snapshot`, then `delta` at most 4×/s, `ping`
  every 15 s) · `GET /api/live` (the whole book as JSON) · `POST /api/live/watch` · `POST /api/live/unwatch`.
- `/api/positions` and every `getSnapshot` caller now answer from the book when it already holds the data.

Check it by hand on the Mac: `curl -N localhost:3333/api/stream`.

## Test
```bash
# Check bridge is running
curl http://localhost:3333/api/health

# Get SPX market data
curl http://localhost:3333/api/market-data?underlying=SPX

# Get SPY market data
curl http://localhost:3333/api/market-data?underlying=SPY
```

## Environment Variables (optional)
```
BRIDGE_PORT=3333      # Local server port (default: 3333)
TWS_HOST=127.0.0.1    # TWS host (default: localhost)
TWS_PORT=7496         # TWS API port (default: 7496, paper: 7497)
CLIENT_ID=99          # TWS client ID (default: 99)
```

## Troubleshooting
- **"TWS connection timeout"** — TWS not running or API not enabled
- **"No market data"** — Check TWS has market data subscriptions for SPX/SPY/VIX
- **VWAP shows 0** — Need real-time market data subscription (not delayed)
- **Ngrok disconnects** — Free tier limits; consider ngrok paid or Cloudflare Tunnel

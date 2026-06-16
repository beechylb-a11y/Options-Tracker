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

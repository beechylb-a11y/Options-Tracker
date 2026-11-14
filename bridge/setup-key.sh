#!/bin/bash
# One-off setup on the Mac (Nov 2026):
#   1. bridge key — the bridge refuses ngrok calls without it (auth.js)
#   2. TWS capture — hourly copy of TWS executions and positions into Supabase (captureTws.js)
# Safe to run again: keeps an existing key and DATABASE_URL.
#   cd ~/Options-Tracker/bridge && bash setup-key.sh
set -euo pipefail
cd "$(dirname "$0")"
BRIDGE_DIR="$(pwd)"
NODE="$(command -v node)"
UIDN="$(id -u)"
touch .env

echo "== Installing pg for the capture job"
npm install --silent

if ! grep -q '^BRIDGE_KEY=' .env; then
  echo "BRIDGE_KEY=$(openssl rand -hex 24)" >> .env
  echo "== New bridge key written to bridge/.env"
else
  echo "== Keeping the existing bridge key"
fi
KEY="$(grep '^BRIDGE_KEY=' .env | head -1 | cut -d= -f2-)"

if ! grep -q '^DATABASE_URL=' .env; then
  if [ -f ../server/.env ] && grep -q '^DATABASE_URL=' ../server/.env; then
    grep '^DATABASE_URL=' ../server/.env | head -1 >> .env
    echo "== DATABASE_URL copied from server/.env"
  else
    echo "!! No DATABASE_URL found. Add DATABASE_URL=... (Supabase connection string) to bridge/.env, then run this again."
    exit 1
  fi
fi

echo "== Restarting the bridge so it picks up the key"
if launchctl print "gui/$UIDN/com.options-tracker.ib-bridge" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$UIDN/com.options-tracker.ib-bridge"
else
  echo "   (bridge isn't a launchd job here — restart 'npm start' yourself)"
fi

echo "== Installing the hourly TWS capture"
PLIST="$HOME/Library/LaunchAgents/com.options-tracker.tws-capture.plist"
sed -e "s#/usr/local/bin/node#$NODE#" -e "s#/Users/lewis/Options-Tracker/bridge#$BRIDGE_DIR#" \
  com.options-tracker.tws-capture.plist > "$PLIST"
launchctl bootout "gui/$UIDN" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UIDN" "$PLIST"

sleep 8
echo "== First capture:"
tail -n 3 /tmp/tws-capture.log 2>/dev/null || echo "   (no log yet — check /tmp/tws-capture.log in a minute)"

echo "== Checking the key through ngrok"
NG="$(curl -s localhost:4040/api/tunnels | sed -n 's/.*"public_url":"\(https:[^"]*\)".*/\1/p' | head -1 || true)"
if [ -n "$NG" ]; then
  echo "   without key: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H 'ngrok-skip-browser-warning: 1' "$NG/api/health")  (want 401)"
  echo "   with key:    HTTP $(curl -s -o /dev/null -w '%{http_code}' -H 'ngrok-skip-browser-warning: 1' -H "X-Bridge-Key: $KEY" "$NG/api/health")  (want 200)"
fi

printf %s "$KEY" | pbcopy 2>/dev/null && COPIED=" (copied to the clipboard)" || COPIED=""
echo
echo "Bridge key$COPIED:"
echo "  $KEY"
echo "Paste it into the app: Settings → IBKR Bridge → Bridge key, then press Test."

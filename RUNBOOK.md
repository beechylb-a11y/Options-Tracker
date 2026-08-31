# Options Tracker — Runbook

Things you need at 09:25 and cannot afford to go looking for. Keep this file in the
repo so it travels with the code and survives any one chat.

---

## 1. Google re-auth (fixes a red Sheets dot)

Open this URL directly in the browser. Sign in, accept, done — both status dots should
go green within a few seconds.

```
https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fspreadsheets%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email&prompt=consent&response_type=code&client_id=553411988068-conv8041v4d3n2j69trk240u338q3kj7.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Foptions-tracker-production.up.railway.app%2Fauth%2Fgoogle%2Fcallback
```

**Do not** just open `/auth/google` — that route returns the URL as JSON rather than
redirecting to it. If the link above ever goes stale (client id or redirect changes),
regenerate it:

```bash
curl -s https://options-tracker-production.up.railway.app/auth/google | python3 -m json.tool
```

`access_type=offline` + `prompt=consent` are both required — without them Google
returns an access token with no refresh token and the app breaks again within the hour.

### Making it stick across restarts

The callback only sets the token **in memory**. Railway's `GOOGLE_TOKENS` env var still
holds the old blob, so a restart reverts to it. To make a re-auth permanent, take the
line the callback logs:

```
[AUTH] ===== COPY THE LINE BELOW INTO Railway env var GOOGLE_TOKENS (one-time) =====
```

and paste it into Railway → Variables → `GOOGLE_TOKENS`.

If Google issues a grant with **no** refresh token, revoke the app at
<https://myaccount.google.com/permissions> first, then re-auth. Re-consenting without
revoking returns only an access token and loops.

### Diagnosis notes

`/auth/status` reports what the server thinks it has:

```bash
curl -s https://options-tracker-production.up.railway.app/auth/status
# {"authenticated":true,"hasRefreshToken":true,"sheetId":"..."}
```

**A working `/api/decisions` does NOT prove auth is healthy.** Seen in the wild
(Aug 2026): `/auth/status` said authenticated with a refresh token, `/api/decisions`
returned the full 77KB payload, and `/api/config`, `/api/accounts`, `/api/trades` and
`/api/stats` all returned empty. It looked like a Config-tab problem and was not — the
re-auth above fixed it. So if some sheet-backed routes work and others don't, re-auth
first and investigate second.

The Railway logs are the fastest real answer — every one of those handlers ends in
`res.status(500).json({ error: err.message })`, so the cause is one line in the log.

---

## 2. IBKR bridge

Restart (this is the one to use — `launchctl load` on an already-loaded agent returns
the confusing `Load failed: 5: Input/output error`):

```bash
launchctl kickstart -k gui/$(id -u)/com.options-tracker.ib-bridge
```

Verify. Note `/api/health` only reports a flag and does **not** trigger a TWS connect,
so `connected:false` there is normal until something asks for data — hit market-data:

```bash
curl -s http://localhost:3333/api/health
curl -s "http://localhost:3333/api/market-data?underlying=SPX" | python3 -m json.tool | grep -i vwap
```

Expect `vwap5`, `vwap5_30`, `vwapRoll30`, `vwapRoll30Prior`, `vwapAccept` — and **no**
`vwap15`. If `vwap15` is present, an old bridge build is still running.

Legitimate "unavailable" values, not faults:
- `vwapRoll30` / `vwapRoll30Prior` are `0` before ~10:30 ET (needs 12 five-minute bars)
- `vwapAccept` is `-1` when there is no reading; `0` is a **real** reading (nothing
  closed above VWAP all hour), not a missing value

Get the ngrok URL for Settings → Bridge URL (it changes on every ngrok restart):

```bash
curl -s http://localhost:4040/api/tunnels | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])"
```

Logs and status:

```bash
tail -f /tmp/ib-bridge.log
tail -f /tmp/ngrok.log
launchctl list | grep options-tracker
```

Run in the foreground to watch it start (stop the agent first or port 3333 is taken):

```bash
launchctl bootout gui/$(id -u)/com.options-tracker.ib-bridge
cd ~/Options-Tracker/bridge && npm start
```

Reinstall the agents if `launchctl list | grep options-tracker` is empty:

```bash
cd ~/Options-Tracker/bridge && bash setup-autostart.sh
```

Run the script — don't copy the plist by hand. The checked-in copy contains
`/Users/lewis/Options-Tracker/bridge` and `/usr/local/bin/node`; the script rewrites
both to your `$HOME` and your real `which node` on install. Sanity check:

```bash
grep -A2 WorkingDirectory ~/Library/LaunchAgents/com.options-tracker.ib-bridge.plist
```

If it still says `lewis`, every "restart" has been silently doing nothing.

**A git push does not update the bridge.** It runs locally from `~/Options-Tracker/bridge`.
Railway redeploys client and server only.

---

## 3. Config sheet

Sheet ID `1eTRcAb1lbGsehcMj8TiUu2mNMWO09RKubRBOa44MwEE`, tab `Config`, layout is
`Setting | Value` in A1:B, keys from row 2 down.

### Account IDs are frozen — never re-create an account

`Add account` mints a new id from `name-slug + Date.now().toString(36)`. Every logged
trade carries the **old** id in its Account column, so re-creating an account silently
detaches your entire history from it. If accounts ever vanish from Settings, restore the
`accounts` row by hand with these exact ids:

| Account    | id                    |
|------------|-----------------------|
| TastyTrade | `bank-mq1x6lg7`       |
| IBKR       | `operating-mq1x6rk3`  |
| MBT        | `mbt-mq1x7a7d`        |
| PaperTrade | `papertrade-mqr9v3pt` |
| BSF        | `bsf-mqucg8mq`        |

Row shape:

```json
[{"id":"bank-mq1x6lg7","name":"TastyTrade","bankroll":3000,"startingBankroll":3000,"maxDailyLoss":300,"maxOpenRisk":450}, ...]
```

Before retyping anything, try **File → Version history** — restoring the last good
version brings back the real bankroll figures too.

### Tab names are exact and case-sensitive

The server reads `Config!A:B`, `Trades!A:P`, `TradeTracker!...`, `Decisions!A:BA`. A
rename, a trailing space or a lowercase letter gives a 400 and an empty response on that
route only.

### `googleTokens` row

There is a leftover `googleTokens` key in Config. `saveTokensToConfig` is now a
deliberate no-op for the sheet — a token blob in Config once corrupted the key/value
layout and broke `getAccounts()`, and a refresh token does not belong in a spreadsheet.
Safe to delete the row; the refresh token lives only in Railway's `GOOGLE_TOKENS`.

---

## 4. Deploy

```bash
cd ~/Options-Tracker
git add -A
git commit -m "..."
git push origin main
```

Railway auto-deploys client + server on push to `main`. Verify the deployed bundle
matches your source — Vite hashes on content, so if the hash from a local
`cd client && npm run build` resolves on the deployed site, they are byte-identical:

```bash
curl -sI https://options-tracker-production.up.railway.app/assets/index-<hash>.js | head -1
```

A bogus hash falls back to `index.html`, so a 200 alone is not proof — check that the
response is JavaScript and not the HTML shell.

Verification pattern before pushing engine changes:

```bash
cp -r client /tmp/check && cd /tmp/check/client && npm install -s && npm run build
```

A Vite/Rollup failure is the definitive signal for a JSX or syntax error.

---

## 5. Trade-log analysis

```bash
node tools/vwap-backtest.mjs
```

Scores each VWAP component against realised P&L as AUC with confidence intervals, plus
setup score as a control. It refuses to report below 20 usable trades and tells you how
many you need. As of Aug 2026: 30 logged decisions, ~29 closed. You need roughly 530 to
show a signal of this kind beats a coin flip and ~2,900 to show one beats another, so
expect it to keep saying "not enough data" for a long while.

Read the control row first. If the whole setup score cannot separate winners from losers
on your sample, no single component of it will either.

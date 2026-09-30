# Options Tracker — Runbook

Things you need at 09:25 and cannot afford to go looking for. Keep this file in the
repo so it travels with the code and survives any one chat.

---

## 1. Sign-in and database (fixes a red DB dot)

Data lives in Supabase — project **TBC App** (`dqyjdxlixzzxxxsqjxfq`), schema `options`.
The Google Sheet is a frozen archive since the Sep 2026 cutover; nothing writes to it.

- **Can't sign in / "not allowed to use this app"** — login is Supabase Auth
  (email + password, the same account as TBC App). Only emails in
  `options.allowed_users` get past the API. Add one in the Supabase SQL editor:
  `insert into options.allowed_users values ('you@example.com');`
- **Red DB dot / 500s everywhere** — Railway logs show `[DB] Startup check failed`.
  Check `DATABASE_URL` (session pooler string, user `options_app.dqyjdxlixzzxxxsqjxfq`).
  Rotate the password with `alter role options_app password '...'` and update Railway.
- **Railway env vars**: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `CLIENT_URL`. All the old `GOOGLE_*` and `SPREADSHEET_ID` vars can be deleted.
- `options_app` can only see the `options` schema — never the TBC tables. Keep it that way.

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

## 3. Config table

`options.config` (`key`, `value`, `sort_order`). Values can be simple formulas over
other keys, evaluated on read — e.g. `maxDailyLoss = =currentBankroll*0.2`, carried
over from the sheet's `=B2*0.2`.

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

Fix it with `update options.config set value = '[...]' where key = 'accounts';`
Supabase daily backups (Database → Backups) are the equivalent of version history,
but a restore rolls back the whole TBC App project, so prefer a targeted update.

### Row numbers are load-bearing

Every data table has `row_no` = the old sheet row (header was row 1, data starts at 2).
`closes.ticket_ref` points at `decisions.row_no`, and the UI's `rowIndex` is the same
number. Never renumber `decisions`. Typed views for analysis: `options.decisions_v`,
`options.trade_log_v`.

---

## 4. Macro event calendar

```bash
cd ~/Options-Tracker
node tools/refresh-calendar.mjs
git add -A && git commit -m "Refresh macro event calendar" && git push origin main
```

Rewrites `client/src/engine/econ-calendar.js`. Railway redeploys on push — no bridge
reload, this is client-side.

### How often

There is no cadence to remember: **the ticket tells you 30 days before a feed runs out**,
and again once it actually has. Run it when you see either notice, or monthly if you
prefer a habit. A scheduled task ("Macro calendar check") also checks the runway monthly.

BLS is almost always the binding constraint — it schedules least far ahead. As of
2026-09-11: Fed to 2026-12-30, BEA to 2026-12-23, **BLS to 2026-12-15**. Next year's
schedules usually publish in autumn, so a refresh then should extend all three well
into 2027.

### The three feeds

| Source | URL | Gives |
|---|---|---|
| Fed | `federalreserve.gov/json/calendar.json` | FOMC statements, minutes |
| BLS | `bls.gov/schedule/news_release/bls.ics` | CPI, PPI, payrolls, ECI, JOLTS |
| BEA | `bea.gov/news/schedule/ics/online-calendar-subscription.ics` | PCE, GDP |

All three are automated. Two traps are already handled, and both would fail *silently*
if reintroduced:

- **BEA publishes UTC** (`DTSTART:...Z`); BLS publishes `TZID=US-Eastern`. Reading BEA's
  digits raw turns an 08:30 pre-open PCE into a 12:30 intraday event — four hours wrong,
  and wrong in the direction that inverts the entire 0DTE pre-open/intraday distinction.
  Conversion goes through `Intl` so DST is handled, not assumed.
- **BEA never says "PCE."** The release is titled `Personal Income and Outlays`. Matching
  on the obvious word finds nothing and leaves a calendar that looks fine and is empty.

`bls.gov/schedule/news_release/` (the HTML page) blocks automated requests. The `.ics`
does not. Don't switch back to scraping the page.

### Reading the ticket

Three tiers, and the distinction is deliberate:

- **Blockers** (red) — the trade isn't takeable as configured
- **Warnings** (amber; violet + 📅 for calendar ones) — takeable, but they downgrade the
  decision to "Trade with caution"
- **Notices** (grey) — facts about the *data*, never about the trade. They never gate the
  decision. Coverage gaps live here, because a permanent alarm is an ignored alarm.

Silence means checked and clear, never "didn't know" — that is what the coverage notices
are protecting.

---

## 5. Deploy

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

## 6. Trade-log analysis

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

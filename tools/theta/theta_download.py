#!/usr/bin/env python3
"""ThetaData history downloader for Shadowbook (Nov 2026) - Python library version.

No Theta Terminal needed: the `thetadata` library talks to ThetaData's servers directly.
Logs in with creds.txt (email line 1, password line 2) - by default ~/ThetaTerminal/creds.txt.
Writes gzip CSV, one file per symbol per day. Resumable: days already on disk are skipped.

    python theta_download.py --only 0dte --symbols SPXW --from 2026-11-17 --to 2026-11-21   # test week
    python theta_download.py                                                                # everything

What it fetches
  0dte : every expiry date, that expiry's 1-minute NBBO quotes 09:30-16:00, strikes near spot
  45dte: every weekday, one 15:45 quote for every expiry up to 60 DTE (daily marks for 45DTE)
"""
import argparse, datetime as dt, gzip, inspect, io, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

STRIKE_RANGE = {"SPXW": 60, "SPX": 60, "XSP": 30, "SPY": 30, "QQQ": 30, "IWM": 12}

p = argparse.ArgumentParser()
today = dt.date.today()
p.add_argument("--symbols", default="SPXW,XSP,SPY,QQQ,IWM")
p.add_argument("--from", dest="start", default=str(today - dt.timedelta(days=int(6 * 365.25))))
p.add_argument("--to", dest="end", default=str(today - dt.timedelta(days=1)))
p.add_argument("--only", choices=["0dte", "45dte"])
p.add_argument("--all-strikes", action="store_true")
p.add_argument("--out", default=str(Path.home() / "Options-Tracker" / "data" / "thetadata"))
p.add_argument("--creds", default=str(Path.home() / "ThetaTerminal" / "creds.txt"))
p.add_argument("--threads", type=int, default=2)
p.add_argument("--dry-run", action="store_true")
a = p.parse_args()

OUT = Path(a.out).expanduser()
START, END = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
SYMBOLS = [s.strip().upper() for s in a.symbols.split(",") if s.strip()]
OUT.mkdir(parents=True, exist_ok=True)
LOG = OUT / "download.log"


def log(msg):
    line = f"{dt.datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


try:
    from thetadata import ThetaClient
except ImportError:
    sys.exit("The thetadata library isn't installed. Run:  pip install thetadata")

if not Path(a.creds).expanduser().exists():
    sys.exit(f"No creds file at {a.creds} (email on line 1, password on line 2).")
_c = Path(a.creds).expanduser().read_text().split()
client = ThetaClient(email=_c[0], password=_c[1])


def is_no_data(e):
    s = f"{type(e).__name__} {e}".lower()
    return "no data" in s or "nodata" in s or "472" in s or "not found" in s


def call(fn, **kw):
    """Retry transient failures; return None for 'no data'."""
    for attempt in range(1, 6):
        try:
            return fn(**kw)
        except Exception as e:  # library raises its own types; sort them by message
            if is_no_data(e):
                return None
            if attempt == 5:
                raise
            time.sleep(2 ** attempt)


def to_csv(df):
    if df is None:
        return ""
    if hasattr(df, "write_csv"):          # polars
        return df.write_csv()
    if hasattr(df, "to_csv"):             # pandas
        return df.to_csv(index=False)
    return "\n".join(",".join(map(str, r)) for r in df)


def n_rows(df):
    if df is None:
        return 0
    try:
        return len(df)
    except TypeError:
        return 0


def expirations(symbol):
    names = [m for m in dir(client) if "list" in m and "expir" in m and m.startswith("option")]
    if not names:
        sys.exit(f"Can't find the list-expirations call in this library version. Calls with 'expir': {[m for m in dir(client) if 'expir' in m]}")
    df = call(getattr(client, names[0]), symbol=symbol)
    if df is None:
        return []
    col = "expiration" if "expiration" in getattr(df, "columns", []) else list(df.columns)[-1]
    vals = df[col].to_list() if hasattr(df[col], "to_list") else list(df[col])
    out = []
    for v in vals:
        d = v if isinstance(v, dt.date) else dt.date.fromisoformat(str(v)[:10] if "-" in str(v) else f"{str(v)[:4]}-{str(v)[4:6]}-{str(v)[6:8]}")
        if START <= d <= END:
            out.append(d)
    return sorted(set(out))


def weekdays():
    d = START
    while d <= END:
        if d.weekday() < 5:
            yield d
        d += dt.timedelta(days=1)


def job(kind, symbol, day, kw):
    folder = OUT / kind / symbol
    f, empty = folder / f"{day}.csv.gz", folder / f"{day}.empty"
    if (f.exists() and f.stat().st_size) or empty.exists():
        return "skip"
    if a.dry_run:
        return "plan"
    folder.mkdir(parents=True, exist_ok=True)
    try:
        df = call(client.option_history_quote, symbol=symbol, interval="1m", **kw)
    except Exception as e:
        log(f"FAIL {kind} {symbol} {day} {type(e).__name__}: {str(e)[:200]}")
        return "fail"
    if n_rows(df) == 0:
        empty.write_text("no data\n")
        return "empty"
    f.write_bytes(gzip.compress(to_csv(df).encode()))
    return "ok"


def run(label, jobs):
    tally = {"ok": 0, "empty": 0, "skip": 0, "fail": 0, "plan": 0}
    t0, done = time.time(), 0
    with ThreadPoolExecutor(max_workers=max(1, a.threads)) as pool:
        for r in pool.map(lambda j: job(*j), jobs):
            tally[r] += 1
            done += 1
            if done % 25 == 0 or done == len(jobs):
                rate = done / max(1e-9, time.time() - t0)
                left = round((len(jobs) - done) / rate / 60) if rate else "?"
                print(f"{label}: {done}/{len(jobs)} · ok {tally['ok']} · empty {tally['empty']} · skip {tally['skip']} · fail {tally['fail']} · ~{left} min left", flush=True)
    log(f"{label} done: {tally}")


log(f"start · {','.join(SYMBOLS)} · {START} to {END} · only {a.only or 'all'} · out {OUT}")
jobs0, jobs45 = [], []
for s in SYMBOLS:
    if a.only != "45dte":
        exps = expirations(s)
        log(f"0dte {s}: {len(exps)} expiry days in range")
        for d in exps:
            kw = dict(expiration=d, date=d)
            if not a.all_strikes:
                kw["strike_range"] = STRIKE_RANGE.get(s, 30)
            jobs0.append(("0dte", s, d, kw))
    if a.only != "0dte":
        for d in weekdays():
            jobs45.append(("45dte", s, d, dict(expiration="*", date=d, start_time="15:45:00", end_time="15:45:00", max_dte=60)))
if jobs0:
    run("0dte", jobs0)
if jobs45:
    run("45dte", jobs45)
log("finished")

// ================================================================
//  SCHEDULED MACRO EVENT CALENDAR
//  Refresh with:  node tools/refresh-calendar.mjs
// ================================================================
//
// Scheduled macro events the engines warn on. Refresh with: node tools/refresh-calendar.mjs
//
// Every event carries a `source`. This is the point of the file:
//   fed-json - pulled from federalreserve.gov/json/calendar.json and verified
//   manual   - typed in from the official BLS/BEA schedule by a human
//   rule     - DERIVED from a calendar convention, NOT confirmed. Treat as provisional.
// The ticket shows the source, so an inferred date never looks like a confirmed one.
//
// blsLoaded=false means CPI/PPI/payrolls dates have never been entered. The engines
// say so on the ticket rather than showing a clean bill of health, because a calendar
// that fails silently returns 'no events', which reads exactly like 'all clear'.
// BLS blocks automated requests, so those dates cannot be scraped - they are typed in
// once or twice a year from https://www.bls.gov/schedule/news_release/
//
// Times are US Eastern, 24h. Use the real release time: it decides whether a 0DTE
// event lands before the open (wide opening range, then IV crush) or inside the
// session (shock risk while you are holding).
//
// A .js module rather than .json on purpose: a bare JSON import needs an import
// attribute under plain Node, so the engines would build under Vite but throw the
// moment any script (a backtest harness, a test) imported them outside the bundler.
//
// Past FOMC dates, kept for reference when reconciling the feed:
//   2026-01-28  FOMC
//   2026-03-18  FOMC
//   2026-04-29  FOMC
//   2026-06-17  FOMC
//   2026-07-29  FOMC
//   2026-08-19  FOMC_MINUTES
//
// BLS template - copy an entry, fill the date, set source:"manual":
//   {"date": "YYYY-MM-DD", "time": "08:30", "kind": "CPI", "label": "CPI", "source": "manual"}
//   {"date": "YYYY-MM-DD", "time": "08:30", "kind": "NFP", "label": "Employment Situation", "source": "manual"}
//   {"date": "YYYY-MM-DD", "time": "08:30", "kind": "PPI", "label": "PPI", "source": "manual"}
//   {"date": "YYYY-MM-DD", "time": "08:30", "kind": "PCE", "label": "PCE price index", "source": "manual"}

export default {
  "generatedAt": "2026-09-11",
  "horizonEnd": "2027-06-11",
  "blsLoaded": true,
  "timezone": "America/New_York",
  "severity": {
    "FOMC": "high",
    "CPI": "high",
    "NFP": "high",
    "PCE": "high",
    "FOMC_MINUTES": "medium",
    "PPI": "medium",
    "ECI": "medium",
    "RETAIL_SALES": "medium",
    "ISM": "medium",
    "GDP": "medium",
    "JOLTS": "low",
    "CLAIMS": "low",
    "CONSUMER_CONFIDENCE": "low",
    "BEIGE_BOOK": "low",
    "FED_SPEECH": "low"
  },
  "events": [
    {
      "date": "2026-09-11",
      "time": "08:30",
      "kind": "CPI",
      "label": "CPI",
      "source": "bls-ics"
    },
    {
      "date": "2026-09-16",
      "time": "14:00",
      "kind": "FOMC",
      "label": "FOMC statement",
      "source": "fed-json"
    },
    {
      "date": "2026-09-29",
      "time": "10:00",
      "kind": "JOLTS",
      "label": "JOLTS",
      "source": "bls-ics"
    },
    {
      "date": "2026-09-30",
      "time": "08:30",
      "kind": "PCE",
      "label": "PCE (Personal Income and Outlays)",
      "source": "bea-ics"
    },
    {
      "date": "2026-10-02",
      "time": "08:30",
      "kind": "NFP",
      "label": "Employment Situation (payrolls)",
      "source": "bls-ics"
    },
    {
      "date": "2026-10-07",
      "time": "14:00",
      "kind": "FOMC_MINUTES",
      "label": "FOMC minutes",
      "source": "fed-json"
    },
    {
      "date": "2026-10-14",
      "time": "08:30",
      "kind": "CPI",
      "label": "CPI",
      "source": "bls-ics"
    },
    {
      "date": "2026-10-15",
      "time": "08:30",
      "kind": "PPI",
      "label": "PPI",
      "source": "bls-ics"
    },
    {
      "date": "2026-10-28",
      "time": "14:00",
      "kind": "FOMC",
      "label": "FOMC statement",
      "source": "fed-json"
    },
    {
      "date": "2026-10-29",
      "time": "08:30",
      "kind": "GDP",
      "label": "GDP advance estimate",
      "source": "bea-ics"
    },
    {
      "date": "2026-10-29",
      "time": "08:30",
      "kind": "PCE",
      "label": "PCE (Personal Income and Outlays)",
      "source": "bea-ics"
    },
    {
      "date": "2026-10-30",
      "time": "08:30",
      "kind": "ECI",
      "label": "Employment Cost Index",
      "source": "bls-ics"
    },
    {
      "date": "2026-11-03",
      "time": "10:00",
      "kind": "JOLTS",
      "label": "JOLTS",
      "source": "bls-ics"
    },
    {
      "date": "2026-11-06",
      "time": "08:30",
      "kind": "NFP",
      "label": "Employment Situation (payrolls)",
      "source": "bls-ics"
    },
    {
      "date": "2026-11-10",
      "time": "08:30",
      "kind": "CPI",
      "label": "CPI",
      "source": "bls-ics"
    },
    {
      "date": "2026-11-13",
      "time": "08:30",
      "kind": "PPI",
      "label": "PPI",
      "source": "bls-ics"
    },
    {
      "date": "2026-11-18",
      "time": "14:00",
      "kind": "FOMC_MINUTES",
      "label": "FOMC minutes",
      "source": "fed-json"
    },
    {
      "date": "2026-11-25",
      "time": "08:30",
      "kind": "PCE",
      "label": "PCE (Personal Income and Outlays)",
      "source": "bea-ics"
    },
    {
      "date": "2026-12-01",
      "time": "10:00",
      "kind": "JOLTS",
      "label": "JOLTS",
      "source": "bls-ics"
    },
    {
      "date": "2026-12-04",
      "time": "08:30",
      "kind": "NFP",
      "label": "Employment Situation (payrolls)",
      "source": "bls-ics"
    },
    {
      "date": "2026-12-09",
      "time": "14:00",
      "kind": "FOMC",
      "label": "FOMC statement",
      "source": "fed-json"
    },
    {
      "date": "2026-12-10",
      "time": "08:30",
      "kind": "CPI",
      "label": "CPI",
      "source": "bls-ics"
    },
    {
      "date": "2026-12-15",
      "time": "08:30",
      "kind": "PPI",
      "label": "PPI",
      "source": "bls-ics"
    },
    {
      "date": "2026-12-23",
      "time": "08:30",
      "kind": "PCE",
      "label": "PCE (Personal Income and Outlays)",
      "source": "bea-ics"
    },
    {
      "date": "2026-12-30",
      "time": "14:00",
      "kind": "FOMC_MINUTES",
      "label": "FOMC minutes",
      "source": "fed-json"
    }
  ],
  "blsThrough": "2026-12-15",
  "fedThrough": "2026-12-30",
  "beaThrough": "2026-12-23"
};

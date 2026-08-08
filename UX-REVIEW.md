# Options Tracker — Full App UX & Information-Design Review
*2026-08-08 · Reviewed: all 11 pages, EnginePanel, engine outputs, shell, utils (~11k lines)*

Goal: professional-trader-grade presentation — maximum data density, minimum input friction, instantly scannable outputs.

---

## Part 1 — Correctness bugs found during review (fix before any UI work)

These change the numbers you see, not just how they look.

1. **Analytics ignores account switching.** `Analytics.jsx:47` — `useMemo` dep array is `[tracker]` but the body filters by `account`. Switching accounts does not update Analytics.
2. **PaperTrade exclusion only exists on Dashboard.** Dashboard builds `AGG_EXCLUDED`; Trades/Journal/Summary/Analytics include PaperTrade in "all" — **total P&L differs page-to-page for the same selection.**
3. **"Today" uses UTC.** `Dashboard.jsx:207`, `Journal.jsx:153` use `toISOString()` — wrong day boundary for your timezone vs US market close. Affects the daily-loss cap readout.
4. **45DTE auto-fill is broken by omission.** `EnginePanel.jsx:566` comments that IV/skew come from Fetch Greeks, but `handleFetchGreeks` (359–444) never writes `iv/ivr/hv/ivFront/ivBack/skew`, and `MKT_45` only fills price+VIX. Six hand-typed fields per 45DTE ticket.
5. **Trades expanded/edit rows keyed by array index.** `Trades.jsx:391,453,484` — changing a filter re-maps indices and opens/edits the **wrong row**.
6. **Analytics mutating sorts.** `Analytics.jsx:132–142` — `bestDow`/`worstDow` computed before an in-place `.sort()`, sublabels read after. Best/worst day results are order-dependent and can be wrong.
7. **PortfolioRisk Greeks double-count.** Greeks stored per-underlying in localStorage (39, 131) but table renders per-position → totals row (366) double-counts when two positions share an underlying.
8. **Entry-hour chart is fiction.** `Analytics.jsx:109` reads `.getHours()` from a date-only field — everything buckets to midnight but the chart still renders with 2+ rows.
9. **Reports infinite spinner when unauthenticated.** `Reports.jsx:12` early-returns without `setLoading(false)`.
10. **Knowledgebase payoff diagrams mismatch.** Fuzzy `.includes()` matching with casing mismatches (`'Broken wing butterfly'` vs `'Broken Wing Butterfly'`) → several strategies show the wrong diagram, silently.
11. **Dashboard drawdown is % of cumulative P&L, not equity** (130) — produces meaningless 90%+ readings early in a curve. Show $ and % of bankroll.
12. **Errors are invisible everywhere.** Every fetch is `.catch(() => [])`. API down renders as "$0 / 0 trades" — indistinguishable from a flat day. Highest-risk pattern in a P&L tool.

---

## Part 2 — The five structural moves (highest leverage)

### 2.1 One shared data layer, one truth
Every page independently refetches `getTracker()` on mount (6 pages), filters accounts differently (client-side vs server-side), and re-derives KPIs with its own math (Dashboard 102–110, Summary via `getPerformance`, Analytics 497–510). BA color thresholds alone exist in three variants (60/40, 50, 60/40).

**Do:** a single `useTradeData()` context (or React Query): one fetch, cached, `dataUpdatedAt` exposed, one `useTradeStats()` hook for KPIs, one `filterByAccount` path, one PaperTrade-exclusion rule. This deletes duplicate logic *and* makes every page agree.

### 2.2 Global context strip (header, always visible)
Nothing tells you how fresh anything is or whether the pipes are up. Add a persistent header strip:

`[Account ▾ + live P&L] · Today P&L · Daily-loss gauge · Open risk · ⟳ Last synced 14:32 · ● Sheets · ● TWS bridge`

- Account switcher moves from bottom-of-sidebar 11-items-deep `text-xs` select (`App.jsx:105`) to the header, persisted to localStorage.
- Bridge status gets a live heartbeat in the shell — today it exists only behind a Settings "Test" button that reports via `alert()`.
- Google dot currently reflects the auth check at page load and never re-verifies.

### 2.3 Navigation: 11 flat tabs → 3 groups + keyboard
Group: **Trade** (Dashboard, Engine, Trades) / **Review** (Journal, Analytics, Portfolio Risk, Reports) / **Reference** (Knowledgebase, Documents, Settings). Add `⌘1–9` or `g d`-style shortcuts, and URL-backed routing (currently a refresh always dumps you on Dashboard).

**Merge/kill:** Summary is a strict subset of Analytics — delete the page, make it an Analytics tab. Knowledgebase checklist state is lost on navigation — move it into the Decision Engine ticket where it belongs. Gmail trade-scan lives in Documents but is trade import — move to Trades.

### 2.4 Trades table → the pro workhorse
Currently: no sorting, no pagination/virtualization, no account column, no subtotal footer, no date/strategy/P&L filters, header count ignores filters, magic leg indices `leg[5]`/`leg[14]` with no labels.

**Do:** sortable sticky headers, account column with color dot, subtotal row for the current filter, date-range + strategy + min/max P&L filters persisted to localStorage, virtualized rows, added columns: ROC (P&L ÷ credit), $/day held, MAE/MFE when available. Keyboard: `j/k` navigate, `Enter` expand, `c` close, `e` edit.

### 2.5 Decision Engine output hierarchy
Seven competing 0–100 scores on screen with no stated governor; EV rendered three times; payoff diagram twice; **P(max loss) — the decisive 0DTE number — buried at the bottom of the input column** under Greeks (1274).

**Do:**
- **Verdict banner owns the decision:** composite score, P(max loss), EV, Kelly contracts — one line, traffic-light. Everything else demotes to detail.
- **Structure comparison table** (the #1 engine feature gap): top-3 rated structures side-by-side on EV / P(max loss) / credit / breakevens / contracts. The multi-scan table (`DecisionEngine.jsx:1201–1230`) is already the exact pattern — reuse it. Today clicking a rating destroys the previous view.
- **Pre-fill Win/Risk from `r.payoff.maxProfit/maxLoss`** (already computed, 1368–1369) with an accept-chip; keep manual override via the existing `held` mechanism.
- **Expose the risk budget.** Bankroll/maxLoss/maxOpen drive Kelly but are rendered nowhere — un-auditable. Add a collapsed "Risk budget" row.
- Replace all ~13 `alert()` calls with the toast system that already exists (`DecisionEngine.jsx:244–247`); replace `window.prompt` for log notes with an inline field.

---

## Part 3 — Page-level improvements

**Dashboard.** 18 equal-weight KPI tiles put static config (starting bankroll) at the same rank as daily-loss-used, with risk limits below the fold. Restructure: sticky decision strip (today P&L, loss-cap gauge, open risk, next expiries) on top; historical stats collapsed below. Add date-range toggle (MTD/30D/90D/YTD/All) — everything is currently all-time or hardcoded `.slice(-30)`. Merge equity curve + drawdown into one chart with a shared x-axis band. Recent-trades table needs account column and click-through to Trades.

**Journal.** Calendar tint is binary (`green/5` vs `red/5`) — a $5 day and $5,000 day look identical. Use a quantile heat scale, add week-total column at row end + month total (the standard prop-firm calendar). Drop `aspect-square` cells (forces 9px text); show $P&L large, `Nt / W-L` small. **Replace `window.location.reload()` after ticket close (492)** — it loses selected day/month/scroll. Make notes editable (currently append-only).

**Analytics.** After fixing the memo/sort bugs: add shared date-range/strategy/account filters; convert DTE × day-of-week to one heatmap grid instead of separate bar charts; add R-multiple histogram, MAE/MFE scatter, Sharpe/Sortino on daily returns. Consider showing all four sections stacked with anchors rather than one-at-a-time tabs.

**Summary (before folding into Analytics).** Add expectancy, profit factor, avg win/loss, Kelly %, avg hold per row; make sortable; grey out rows with n < 10 (a 1-trade 100% BA currently renders the same green badge as a 200-trade one). Two bar charts + table currently render the same dataset three times — replace with one strategy × account (or × DTE bucket) heatmap matrix.

**Portfolio Risk.** Strongest layout in the app, weakest data: Greeks are hand-typed per-underlying into localStorage while a live IBKR bridge exists — pull per-position Greeks from `/api/positions`. Add beta-weighted delta, BPR/margin used, max loss per position. Collapse the three third-width charts into one dense table with sparkline columns.

**Reports.** Tax Summary card restates the executive card, restated again twice in the print HTML. The 100-line print-HTML string (209–309) duplicates all formatting outside the design system — generate it from the same components or a template. Fees: keep manual entry, drop the heuristic CSV text parser.

**Settings.** Content locked to `max-w-2xl` on a 1400px shell — 60% empty. Two columns. Guard "Re-tag all" with more than `confirm()` (it's a destructive overwrite). Surface bridge status here *and* in the shell.

---

## Part 4 — Design-system cleanup

- **Raw hex everywhere:** EnginePanel ~502 hex literals, Analytics 73, CloseTradeModal 75, Documents 62. Documents uses `bg-[#0d1117]` where Settings uses `bg-bg` for the same control. Define the traffic-light scale + chart palette once; Recharts colors are duplicated inline ~30 times.
- **Font trap:** `tailwind.config.js` sets `font-sans` to JetBrains Mono while `index.css` body is DM Sans — `font-sans` yields mono. Fix the token, delete the manual `.mono` sprinkling where it's now redundant.
- **Zero shared presentational components.** Four separate KPI implementations at four sizes; `GInp`, `ScenarioCard`, `CardRow` all page-local. Extract: `Kpi`, `StatBadge`, `SegmentedFilter`, `DataTable` (sortable), `Sparkline`.
- **`fmt$` silently drops cents** (`maximumFractionDigits: 0`) — a $0.45 credit and a $0.40/day theta both render `$0`. Add `fmt$(v, dp)` and a `fmtGreek`; route the hand-rolled `.toFixed(n)+'%'` variants through one `fmtPct`.
- **Loading/error states:** Dashboard has skeletons; most pages render a bare string; no page anywhere has an error UI. Standardize skeleton + error banner + "stale data" badge from the shared data layer.

---

## Suggested sequence

| Phase | Content | Effort |
|---|---|---|
| **1. Truth** | Part 1 bugs #1–#9, shared data layer + `useTradeStats`, error states | ~2–3 sessions |
| **2. Shell** | Header context strip, nav grouping + shortcuts, account switcher, freshness/bridge status | ~1–2 sessions |
| **3. Workhorses** | Trades table rebuild, Engine output hierarchy + structure comparison + 45DTE autofill | ~2–3 sessions |
| **4. Polish** | Journal heatmap calendar, Dashboard restructure, Analytics additions, Summary merge | ~2 sessions |
| **5. System** | Format helpers, shared components, hex → tokens, font fix | ongoing alongside |

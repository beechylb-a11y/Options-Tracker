-- Shadow verdicts, step 3 (Oct 2026): a managed outcome beside the held-to-expiry one.
-- pnl_managed: per contract, after the entry/exit half-spread and commission, exiting
-- at the strategy's profit target, the 100%-of-premium stop or the planned time
-- (0DTE 15:00 ET on 5-min bars; 45DTE the planned close, 21 DTE, on daily closes).
alter table options.shadow_verdicts
  add column if not exists pnl_managed numeric,
  add column if not exists exit_reason text,     -- target | stop | time | expiry
  add column if not exists exit_at text,
  add column if not exists managed_at timestamptz,
  add column if not exists entry_half_spread numeric,
  add column if not exists commission numeric;

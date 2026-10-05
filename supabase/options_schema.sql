-- Options Tracker schema in the TBC App Supabase project (applied 2026-09-30 as migration options_tracker_schema).
-- Everything lives in the `options` schema; the anon/authenticated API roles have no access to it.
create schema if not exists options;
create or replace function options.to_num(t text) returns numeric language sql immutable set search_path = '' as $$ select case when t ~ '^\s*-?\$?[0-9,]*\.?[0-9]+(e-?[0-9]+)?\s*$' then replace(replace(t,'$',''),',','')::numeric end $$;
create table options.config (key text primary key, value text, sort_order int not null default 0, updated_at timestamptz not null default now());
create table options.batting_average (metric text primary key, value text, sort_order int not null default 0, updated_at timestamptz not null default now());
create table options.documents (id uuid primary key default gen_random_uuid(), name text not null, mime_type text, size bigint,
  storage_path text not null unique, meta jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table options.allowed_users (email text primary key);
create table options.trades (
  row_no int primary key check (row_no >= 2), date_time text, order_no text, strategy_oic text, underlying text, instrument_type text, description text, subcode text, symbol text, expiry text, strike text, call_put text, quantity text, avg_price text, fees text, net_value text, currency text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table options.trades is 'Former Google Sheet tab "Trades". row_no = original sheet row (header is row 1); values stored as text exactly as the sheet returned them.';
create table options.trade_tracker (
  row_no int primary key check (row_no >= 2), order_no text, entry_date text, expiry_date text, close_date text, strategy_oic text, underlying text, qty text, net_credit_usd text, total_pnl_usd text, win_loss text, cumul_ba_pct text, status text, account text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table options.trade_tracker is 'Former Google Sheet tab "TradeTracker". row_no = original sheet row (header is row 1); values stored as text exactly as the sheet returned them.';
create table options.decisions (
  row_no int primary key check (row_no >= 2), timestamp text, engine text, underlying text, strategy text, direction text, contracts text, kelly_usd text, pop_margin text, setup_score text, setup_grade text, regime text, wing_strikes text, market_behaviour text, notes text, price text, vix text, vix1d text, iv text, ivr text, em text, matched_trade text, status text, close_date text, close_price text, actual_pnl text, trade_notes text, account text, delta text, theta text, gamma text, vega text, close_iv text, close_vix text, net_debit_credit text, max_risk text, max_profit text, ev text, confidence text, p_max_loss text, em_basis text, cushion_em text, session_high text, session_low text, ivx_open text, underlying_price_close text, vix1d_close text, engine_strikes text, vwap_anchored text, vwap_roll30 text, vwap_roll30_prior text, vwap_acceptance text, vwap_trend text, vwap_dist_em text,
  strike_method text, short_deltas text, implied_pop text,  -- added 2026-10-06 (migration options_decisions_strike_method)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table options.decisions is 'Former Google Sheet tab "Decisions". row_no = original sheet row (header is row 1); values stored as text exactly as the sheet returned them.';
create table options.journal (
  row_no int primary key check (row_no >= 2), date text, day_pnl text, trades_count text, win_count text, loss_count text, notes text, week_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table options.journal is 'Former Google Sheet tab "Journal". row_no = original sheet row (header is row 1); values stored as text exactly as the sheet returned them.';
create table options.closes (
  row_no int primary key check (row_no >= 2), close_id text, ticket_ref text, ticket_timestamp text, engine text, underlying text, strategy text, entry_date text, close_date text, qty_closed text, qty_remaining text, close_price text, pnl_usd text, fees_usd text, account text, notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table options.closes is 'Former Google Sheet tab "Closes". row_no = original sheet row (header is row 1); values stored as text exactly as the sheet returned them.';
create table options.trade_log (
  row_no int primary key check (row_no >= 2), ticket_ref text, entry_date text, entry_time text, engine text, underlying text, strategy text, legs text, qty text, entry_price text, max_risk text, max_profit text, ev text, confidence text, qty_closed text, qty_open text, avg_exit text, realised_pnl text, r_multiple text, status text, tranches text, last_close text, account text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table options.trade_log is 'Former Google Sheet tab "TradeLog". row_no = original sheet row (header is row 1); values stored as text exactly as the sheet returned them.';
-- ── typed views for analysis (read-only; the app itself reads the base tables) ──
create view options.decisions_v with (security_invoker = true) as
select row_no, case when "timestamp" ~ '^\d{4}-\d{2}-\d{2}T' then "timestamp"::timestamptz end as opened_at, engine, underlying, strategy, direction,
  options.to_num(contracts) as contracts, options.to_num(kelly_usd) as kelly_usd, setup_grade, regime,
  wing_strikes, engine_strikes, status, close_date, options.to_num(close_price) as close_price,
  options.to_num(actual_pnl) as actual_pnl, account,
  options.to_num(price) as price, options.to_num(vix) as vix, options.to_num(vix1d) as vix1d,
  options.to_num(iv) as iv, options.to_num(ivr) as ivr, options.to_num(em) as em,
  options.to_num(delta) as delta, options.to_num(theta) as theta, options.to_num(gamma) as gamma, options.to_num(vega) as vega,
  options.to_num(net_debit_credit) as net_debit_credit, options.to_num(max_risk) as max_risk,
  options.to_num(max_profit) as max_profit, options.to_num(ev) as ev, options.to_num(confidence) as confidence,
  options.to_num(p_max_loss) as p_max_loss, options.to_num(cushion_em) as cushion_em,
  options.to_num(session_high) as session_high, options.to_num(session_low) as session_low,
  options.to_num(ivx_open) as ivx_open, options.to_num(close_iv) as close_iv, options.to_num(close_vix) as close_vix,
  options.to_num(underlying_price_close) as underlying_price_close, options.to_num(vix1d_close) as vix1d_close,
  notes, trade_notes
from options.decisions where "timestamp" is not null and "timestamp" <> '';

create view options.trade_log_v with (security_invoker = true) as
select options.to_num(ticket_ref)::int as ticket_ref, entry_date, entry_time, engine, underlying, strategy, legs,
  options.to_num(qty) as qty, options.to_num(entry_price) as entry_price, options.to_num(max_risk) as max_risk,
  options.to_num(max_profit) as max_profit, options.to_num(ev) as ev, options.to_num(confidence) as confidence,
  options.to_num(qty_closed) as qty_closed, options.to_num(qty_open) as qty_open, options.to_num(avg_exit) as avg_exit,
  options.to_num(realised_pnl) as realised_pnl, options.to_num(r_multiple) as r_multiple, status,
  options.to_num(tranches)::int as tranches, last_close, account
from options.trade_log;

-- ── lock it down: nothing in this schema is reachable through the public API roles ──
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'options' loop
    execute format('alter table options.%I enable row level security', t);
  end loop;
end $$;
revoke all on schema options from public, anon, authenticated;
revoke all on all tables in schema options from public, anon, authenticated;
revoke all on all functions in schema options from public, anon, authenticated;

-- Allowlist check, callable by signed-in users (used by storage policies).
create function options.is_allowed() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from options.allowed_users a where a.email = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;
revoke all on function options.is_allowed() from public, anon;
grant usage on schema options to authenticated;
grant execute on function options.is_allowed() to authenticated;

-- ── documents bucket (private; only allowlisted users can touch it) ──
insert into storage.buckets (id, name, public, file_size_limit)
values ('options-docs', 'options-docs', false, 26214400)
on conflict (id) do nothing;

create policy "options-docs allowlisted read" on storage.objects for select to authenticated
  using (bucket_id = 'options-docs' and options.is_allowed());
create policy "options-docs allowlisted insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'options-docs' and options.is_allowed());
create policy "options-docs allowlisted delete" on storage.objects for delete to authenticated
  using (bucket_id = 'options-docs' and options.is_allowed());

-- ── App role (run separately; password is NOT stored in the repo) ──
-- create role options_app login password '<secret>' noinherit;
-- grant usage on schema options to options_app;
-- grant select, insert, update, delete on all tables in schema options to options_app;
-- grant execute on function options.to_num(text) to options_app;
-- do $$ declare t text; begin
--   for t in select tablename from pg_tables where schemaname = 'options' loop
--     execute format('create policy app_all on options.%I for all to options_app using (true) with check (true)', t);
--   end loop;
-- end $$;
-- insert into options.allowed_users (email) values ('<your login email>');

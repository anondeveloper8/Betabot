-- Signal-only schema. No trade execution tables or bot pause control are used
-- by the new application path. Existing bot_* tables are intentionally not
-- dropped, so prior research/demo records remain intact.

create table if not exists signal_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  signal_key text not null unique,
  symbol text not null default 'EURUSD',
  timeframe text not null default 'M15',
  signal_candle_open timestamptz not null,
  signal_candle_close timestamptz not null,
  status text not null check (status in ('BUY', 'SELL', 'WAIT', 'DATA_STALE')),
  direction text check (direction in ('BUY', 'SELL')),
  setup_id text,
  entry_price numeric,
  stop_price numeric,
  target_price numeric,
  rr numeric,
  risk_atr numeric,
  position_size_reference numeric,
  reference_equity numeric not null default 10000,
  reason_codes text[] not null default '{}',
  source text not null default 'Twelve Data',
  source_plan text not null default 'Basic Free',
  latest_m15_age_seconds integer,
  raw_response jsonb not null,
  source_meta jsonb not null default '{}'::jsonb
);

create index if not exists signal_events_created_at_idx on signal_events (created_at desc);
create index if not exists signal_events_candle_idx on signal_events (signal_candle_close desc);

alter table signal_events enable row level security;

do $$ begin
  create policy "signal events are readable publicly" on signal_events
    for select to anon using (true);
exception when duplicate_object then null; end $$;

-- IMPORTANT: no anon insert/update/delete policy exists. The scanner writes
-- through the server-side Supabase service-role key only.

-- Realtime is optional. The PWA uses a no-store read endpoint, so this schema
-- does not require Replication to be enabled.

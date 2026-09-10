-- Betabot Web Push subscription storage.
-- Browser clients never access this table directly; Vercel server functions use the Supabase service-role key.

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  endpoint text not null unique,
  subscription jsonb not null,
  user_agent text
);

alter table push_subscriptions enable row level security;

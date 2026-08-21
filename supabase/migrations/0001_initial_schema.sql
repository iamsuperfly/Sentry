-- DreamDEX Event Contracts bot schema
-- Run this file manually in the Supabase SQL Editor.
-- This schema is intentionally testnet-agnostic at the data layer; the
-- application must enforce Somnia Shannon testnet configuration.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.telegram_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  username text,
  first_name text,
  last_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.user_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.telegram_users(id) on delete cascade,
  trading_enabled boolean not null default false,
  execution_mode text not null default 'testnet'
    check (execution_mode in ('testnet')),
  default_stake_usdso numeric(30, 8) not null default 1
    check (default_stake_usdso > 0),
  max_daily_loss_usdso numeric(30, 8) not null default 10
    check (max_daily_loss_usdso > 0),
  max_trade_stake_usdso numeric(30, 8) not null default 1
    check (max_trade_stake_usdso > 0),
  sentiment_enabled boolean not null default false,
  strategy_name text not null default 'ec-starter',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.telegram_users(id) on delete cascade,
  market_id text not null,
  symbol text not null,
  direction text not null check (direction in ('up', 'down')),
  side text not null check (side in ('buy', 'sell')),
  strategy_name text not null,
  stake_usdso numeric(30, 8) not null check (stake_usdso > 0),
  contracts numeric(30, 8),
  limit_price numeric(20, 18) check (limit_price is null or (limit_price > 0 and limit_price < 1)),
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'partially_filled', 'filled', 'cancelled', 'settled', 'redeemed', 'failed')),
  transaction_hash text unique,
  order_id text,
  outcome text check (outcome is null or outcome in ('up', 'down', 'void')),
  pnl_usdso numeric(30, 8),
  error_message text,
  submitted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.bot_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.telegram_users(id) on delete set null,
  market_id text,
  symbol text,
  strategy_name text not null,
  action text not null check (action in ('buy', 'sell', 'hold', 'skip', 'redeem')),
  direction text check (direction is null or direction in ('up', 'down')),
  confidence numeric(8, 6) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  rationale text,
  sentiment_score numeric(8, 6) check (sentiment_score is null or (sentiment_score >= -1 and sentiment_score <= 1)),
  inputs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.performance_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.telegram_users(id) on delete set null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  trades_count integer not null default 0 check (trades_count >= 0),
  wins_count integer not null default 0 check (wins_count >= 0),
  losses_count integer not null default 0 check (losses_count >= 0),
  volume_usdso numeric(30, 8) not null default 0 check (volume_usdso >= 0),
  pnl_usdso numeric(30, 8) not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  check (period_end > period_start)
);

drop trigger if exists telegram_users_set_updated_at on public.telegram_users;
create trigger telegram_users_set_updated_at
before update on public.telegram_users
for each row execute function public.set_updated_at();

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
before update on public.user_settings
for each row execute function public.set_updated_at();

drop trigger if exists trades_set_updated_at on public.trades;
create trigger trades_set_updated_at
before update on public.trades
for each row execute function public.set_updated_at();

create index if not exists trades_user_created_idx
  on public.trades (user_id, created_at desc);
create index if not exists trades_market_created_idx
  on public.trades (market_id, created_at desc);
create index if not exists trades_status_idx
  on public.trades (status);
create index if not exists bot_decisions_user_created_idx
  on public.bot_decisions (user_id, created_at desc);
create index if not exists bot_decisions_market_created_idx
  on public.bot_decisions (market_id, created_at desc);
create index if not exists performance_logs_user_period_idx
  on public.performance_logs (user_id, period_end desc);

-- The bot backend will use Supabase's service-role connection. RLS remains
-- enabled so an accidentally exposed client key cannot read or mutate data.
alter table public.telegram_users enable row level security;
alter table public.user_settings enable row level security;
alter table public.trades enable row level security;
alter table public.bot_decisions enable row level security;
alter table public.performance_logs enable row level security;
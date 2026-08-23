-- Stage 3: trade intent / execution accounting on top of existing trades table.
-- Per-user isolation remains: each trade references telegram_users + their wallet only.

alter table public.user_settings
  add column if not exists max_open_positions integer not null default 1
    check (max_open_positions > 0 and max_open_positions <= 20);

alter table public.trades
  add column if not exists idempotency_key text,
  add column if not exists strategy_version text,
  add column if not exists decision jsonb not null default '{}'::jsonb,
  add column if not exists filled_contracts numeric(30, 8),
  add column if not exists wallet_address text,
  add column if not exists pool_address text,
  add column if not exists reject_reason text;

-- Unique active intents: same user cannot double-enter the same market+strategy key
-- while a non-terminal row exists. Failed rows may be retried with a new key or
-- after the previous failed row is left terminal.
create unique index if not exists trades_idempotency_key_uidx
  on public.trades (idempotency_key)
  where idempotency_key is not null;

create index if not exists trades_user_open_idx
  on public.trades (user_id, status)
  where status in ('pending', 'submitted', 'partially_filled', 'filled');

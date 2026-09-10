-- Protocol identity, adaptive-stake user prefs, STT gas replenishment.
-- Per-user isolation: every row remains keyed by user_id.

alter table public.trades
  add column if not exists pool_nonce text;

comment on column public.trades.pool_nonce is
  'DreamDEX pool window nonce at persist time. Identity is market_id + pool_address + pool_nonce.';

alter table public.user_settings
  add column if not exists adaptive_stake_bands jsonb;

comment on column public.user_settings.adaptive_stake_bands is
  'Optional per-user adaptive stake bands. NULL means use Sentry system defaults.';

alter table public.blockchain_transactions
  drop constraint if exists blockchain_transactions_type_check;

alter table public.blockchain_transactions
  add constraint blockchain_transactions_type_check
  check (type in ('INITIAL_STT_SPONSOR', 'TUSDC_FAUCET', 'STT_GAS_REPLENISH'));

create table if not exists public.user_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.telegram_users(id) on delete cascade,
  address text not null unique,
  encrypted_private_key text not null,
  chain_id integer not null check (chain_id = 50312),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.blockchain_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.telegram_users(id) on delete cascade,
  wallet_address text not null,
  type text not null check (type in ('INITIAL_STT_SPONSOR', 'TUSDC_FAUCET')),
  amount numeric(38, 6) not null check (amount > 0),
  token_symbol text not null check (token_symbol in ('STT', 'tUSDC')),
  from_address text,
  to_address text,
  transaction_hash text unique,
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'confirmed', 'failed')),
  block_number bigint,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  confirmed_at timestamptz
);

create index if not exists blockchain_transactions_user_created_idx
  on public.blockchain_transactions (user_id, created_at desc);

alter table public.user_wallets enable row level security;
alter table public.blockchain_transactions enable row level security;
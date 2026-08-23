-- Stage 0: durable, UTC-day faucet reservations.
-- The reservation insert happens inside the same locked database function as
-- the allowance check, before the application broadcasts a blockchain call.

create or replace function public.get_faucet_allowance(p_user_id uuid)
returns table (
  consumed numeric,
  remaining numeric,
  "limit" numeric,
  utc_day date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  day_start timestamptz := date_trunc('day', timezone('utc', now())) at time zone 'UTC';
  used_amount numeric;
begin
  if not exists (
    select 1 from public.telegram_users where id = p_user_id and is_active
  ) then
    raise exception 'Telegram user was not found or is inactive' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0)
    into used_amount
    from public.blockchain_transactions
   where user_id = p_user_id
     and type = 'TUSDC_FAUCET'
     and status in ('pending', 'submitted', 'confirmed')
     and created_at >= day_start
     and created_at < day_start + interval '1 day';

  return query select
    used_amount,
    greatest(0::numeric, 500::numeric - used_amount),
    500::numeric,
    (day_start at time zone 'UTC')::date;
end;
$$;

create or replace function public.reserve_faucet_transaction(
  p_user_id uuid,
  p_wallet_address text,
  p_amount numeric
)
returns table (
  transaction_id uuid,
  consumed numeric,
  remaining numeric,
  "limit" numeric,
  utc_day date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  day_start timestamptz := date_trunc('day', timezone('utc', now())) at time zone 'UTC';
  used_amount numeric;
  new_transaction_id uuid;
begin
  if p_amount is null or p_amount <= 0 or p_amount > 500 or scale(p_amount) > 6 then
    raise exception 'Faucet amount must be greater than zero and no more than 500 tUSDC with up to 6 decimal places'
      using errcode = 'P0001';
  end if;

  -- Serializes all reservations for a Telegram user across workers/processes.
  perform 1 from public.telegram_users
    where id = p_user_id and is_active
    for update;
  if not found then
    raise exception 'Telegram user was not found or is inactive' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.user_wallets
     where user_id = p_user_id and address = p_wallet_address and chain_id = 50312
  ) then
    raise exception 'Wallet does not belong to this Telegram user' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0)
    into used_amount
    from public.blockchain_transactions
   where user_id = p_user_id
     and type = 'TUSDC_FAUCET'
     and status in ('pending', 'submitted', 'confirmed')
     and created_at >= day_start
     and created_at < day_start + interval '1 day';

  if used_amount + p_amount > 500 then
    raise exception 'Faucet request exceeds today''s remaining allowance of % tUSDC',
      to_char(greatest(0::numeric, 500::numeric - used_amount), 'FM999999990.######')
      using errcode = 'P0001';
  end if;

  insert into public.blockchain_transactions (
    user_id, wallet_address, type, amount, token_symbol, from_address, to_address, status
  ) values (
    p_user_id, p_wallet_address, 'TUSDC_FAUCET', p_amount, 'tUSDC',
    p_wallet_address, '0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E', 'pending'
  )
  returning id into new_transaction_id;

  return query select
    new_transaction_id,
    used_amount + p_amount,
    500::numeric - used_amount - p_amount,
    500::numeric,
    (day_start at time zone 'UTC')::date;
end;
$$;

revoke all on function public.get_faucet_allowance(uuid) from public;
revoke all on function public.reserve_faucet_transaction(uuid, text, numeric) from public;
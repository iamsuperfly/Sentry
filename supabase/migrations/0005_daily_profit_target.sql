-- Stage 3 risk: optional user daily profit target (stop new trades when reached).
-- Does not alter 0001–0004. System ceilings live in application env, not this table.
-- Stake/loss column names *_usdso remain legacy labels; Shannon runtime unit is tUSDC.

alter table public.user_settings
  add column if not exists daily_profit_target_usdso numeric(30, 8)
    check (
      daily_profit_target_usdso is null
      or daily_profit_target_usdso > 0
    );

comment on column public.user_settings.daily_profit_target_usdso is
  'Optional user daily profit stop (tUSDC units on Shannon). Null = disabled. Not a system safety limit.';

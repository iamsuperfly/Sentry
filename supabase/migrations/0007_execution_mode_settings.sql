-- Stage 7: user execution mode preference (paper | testnet).
-- Does not enable mainnet or bypass ENABLE_LIVE_EXECUTION.

alter table public.user_settings
  drop constraint if exists user_settings_execution_mode_check;

alter table public.user_settings
  add constraint user_settings_execution_mode_check
  check (execution_mode in ('paper', 'testnet'));

comment on column public.user_settings.execution_mode is
  'User preference: paper = never request live chain submit; testnet = may request live when ENABLE_LIVE_EXECUTION is true. Not a protocol setting.';

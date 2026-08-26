-- Stage 8: one-shot finalization notification marker per trade.
-- Used so reconciliation / UX ticks never double-notify the same terminal trade.

alter table public.trades
  add column if not exists finalization_notified_at timestamptz;

comment on column public.trades.finalization_notified_at is
  'Set once when the Telegram finalization notice is sent. Null = not yet notified.';

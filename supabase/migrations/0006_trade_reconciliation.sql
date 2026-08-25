-- Stage 6: post-submission reconciliation support.
-- Additive only. Does not alter existing status semantics or idempotency keys.

-- filled_at is written by updateTradeExecution on fill outcomes.
alter table public.trades
  add column if not exists filled_at timestamptz;

-- Index for recovery workers scanning open submitted/partial rows.
create index if not exists trades_reconciliation_idx
  on public.trades (status, submitted_at)
  where status in ('submitted', 'partially_filled');

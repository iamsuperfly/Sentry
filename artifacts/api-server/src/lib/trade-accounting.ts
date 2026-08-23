/**
 * Pure trade accounting for Stage 4 risk state.
 * No I/O — unit-testable. Shannon PnL units are tUSDC (column name pnl_usdso is legacy).
 */

import type { IntentStatus } from "./execution.ts";

/** Statuses that still represent open exposure (not terminal). */
export const OPEN_TRADE_STATUSES: readonly IntentStatus[] = [
  "pending",
  "submitted",
  "partially_filled",
  "filled",
] as const;

export type TradeRiskRow = {
  user_id: string;
  status: IntentStatus;
  /** Legacy column; value is tUSDC units on Shannon when set. */
  pnl_usdso: number | string | null;
  settled_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export function isOpenTradeStatus(status: string): boolean {
  return (OPEN_TRADE_STATUSES as readonly string[]).includes(status);
}

/** Count open positions for a single user from an in-memory trade list. */
export function countOpenPositions(
  trades: TradeRiskRow[],
  userId: string,
): number {
  return trades.filter(
    (t) => t.user_id === userId && isOpenTradeStatus(t.status),
  ).length;
}

export function utcDayBounds(now: Date = new Date()): {
  start: Date;
  end: Date;
  utcDay: string;
} {
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const utcDay = start.toISOString().slice(0, 10);
  return { start, end, utcDay };
}

function pnlNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Realized PnL for the current UTC calendar day.
 * Only rows with a non-null pnl_usdso count (unrealized / open without PnL excluded).
 * Timestamp preference: settled_at, else updated_at, else created_at.
 */
export function sumRealizedPnlUtcDay(
  trades: TradeRiskRow[],
  userId: string,
  now: Date = new Date(),
): number {
  const { start, end } = utcDayBounds(now);
  let total = 0;
  for (const t of trades) {
    if (t.user_id !== userId) continue;
    const pnl = pnlNumber(t.pnl_usdso);
    if (pnl === null) continue;
    const raw = t.settled_at ?? t.updated_at ?? t.created_at;
    if (!raw) continue;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) continue;
    if (when >= start && when < end) total += pnl;
  }
  return total;
}

/** Idempotent insert outcome for tests / handlers. */
export type IdempotentInsertResult<
  T extends { id: string; idempotency_key: string | null },
> =
  | { kind: "created"; trade: T }
  | { kind: "existing"; trade: T };

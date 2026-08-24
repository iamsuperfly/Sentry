import type { IntentStatus } from "./execution.ts";

export const OPEN_TRADE_STATUSES = [
  "pending",
  "submitted",
  "partially_filled",
  "filled",
] as const satisfies ReadonlyArray<IntentStatus>;

export const TERMINAL_TRADE_STATUSES = [
  "cancelled",
  "settled",
  "redeemed",
  "failed",
] as const satisfies ReadonlyArray<IntentStatus>;

export function isOpenTradeStatus(status: string): boolean {
  return (OPEN_TRADE_STATUSES as readonly string[]).includes(status);
}

export function isTerminalTradeStatus(status: string): boolean {
  return (TERMINAL_TRADE_STATUSES as readonly string[]).includes(status);
}

export function getUtcDayBounds(now = new Date()): {
  start: string;
  end: string;
} {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  return { start: dayStart.toISOString(), end: dayEnd.toISOString() };
}

export function sumRealizedPnl(
  rows: ReadonlyArray<{ pnl_usdso: string | number | null }>,
): number {
  return rows.reduce((total, row) => {
    if (row.pnl_usdso === null) return total;
    const value = Number(row.pnl_usdso);
    if (!Number.isFinite(value)) throw new Error("Invalid persisted pnl_usdso.");
    return total + value;
  }, 0);
}
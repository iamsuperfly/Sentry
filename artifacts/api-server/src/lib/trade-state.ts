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

export type PendingIntentMarketState = {
  marketId: string;
  expiry: string;
  indexerStatus: string;
  onchainStatus: number;
  tradable: boolean;
  finalized: boolean;
};

export function isStalePendingIntent(input: {
  status: string;
  transactionHash: string | null;
  filledContracts: string | number | null;
  market: PendingIntentMarketState | undefined;
  nowSec: number;
}): boolean {
  if (input.status !== "pending") return false;
  if (input.transactionHash) return false;
  if (input.filledContracts !== null && Number(input.filledContracts) > 0)
    return false;
  const market = input.market;
  if (!market) return false;

  const expiry = Number(market.expiry);
  const expired = Number.isFinite(expiry) && expiry <= input.nowSec;
  return (
    expired ||
    market.finalized ||
    market.indexerStatus === "Finalized" ||
    !market.tradable ||
    market.onchainStatus !== 1
  );
}
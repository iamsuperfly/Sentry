/**
 * Position listing for Telegram: open statuses filtered by real market expiry.
 */

import type { AppConfig } from "../config.ts";
import { shouldShowInPositions } from "./position-lifecycle.ts";
import { getSupabaseClient } from "./supabase.ts";
import {
  formatHistoryBlock,
  formatPositionBlock,
  type DisplayTrade,
} from "./telegram-trade-format.ts";
import { OPEN_TRADE_STATUSES, TERMINAL_TRADE_STATUSES } from "./trade-state.ts";

/** Default number of terminal trades shown on /history. */
export const HISTORY_DISPLAY_LIMIT = 5;

function decisionMeta(decision: unknown): {
  marketExpiry: string | number | null;
  tradingStart: string | number | null;
  intervalSec: string | number | null;
} {
  if (!decision || typeof decision !== "object") {
    return { marketExpiry: null, tradingStart: null, intervalSec: null };
  }
  const d = decision as Record<string, unknown>;
  return {
    marketExpiry: (d.expiry as string | number | null | undefined) ?? null,
    tradingStart:
      (d.tradingStart as string | number | null | undefined) ?? null,
    intervalSec: (d.intervalSec as string | number | null | undefined) ?? null,
  };
}

function mapRow(row: Record<string, unknown>): DisplayTrade {
  const meta = decisionMeta(row.decision);
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: String(row.id),
    symbol: String(row.symbol ?? ""),
    direction: String(row.direction ?? ""),
    status: String(row.status ?? ""),
    stake: Number(row.stake_usdso ?? 0),
    contracts: num(row.contracts),
    filledContracts: num(row.filled_contracts),
    limitPrice: num(row.limit_price),
    transactionHash: (row.transaction_hash as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    marketExpiry: meta.marketExpiry,
    tradingStart: meta.tradingStart,
    intervalSec: meta.intervalSec,
    outcome: (row.outcome as string | null) ?? null,
    pnl: num(row.pnl_usdso),
  };
}

const SELECT =
  "id, symbol, direction, status, stake_usdso, contracts, filled_contracts, limit_price, market_id, transaction_hash, error_message, outcome, pnl_usdso, decision, created_at, submitted_at, filled_at";

export async function listActivePositionsForDisplay(
  config: AppConfig,
  userId: string,
  limit = 20,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<DisplayTrade[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(SELECT)
    .eq("user_id", userId)
    .in("status", [...OPEN_TRADE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(limit * 3);

  if (error) throw new Error("Unable to list open positions.");

  const mapped = (data ?? []).map((row) =>
    mapRow(row as Record<string, unknown>),
  );
  return mapped
    .filter((trade) =>
      shouldShowInPositions({
        status: trade.status,
        marketExpiry: trade.marketExpiry,
        nowSec,
      }),
    )
    .slice(0, limit);
}

export async function listHistoryForDisplay(
  config: AppConfig,
  userId: string,
  limit = HISTORY_DISPLAY_LIMIT,
): Promise<DisplayTrade[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(SELECT)
    .eq("user_id", userId)
    .in("status", [...TERMINAL_TRADE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error("Unable to list trade history.");
  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export function formatPositionsMessage(
  trades: DisplayTrade[],
  explorerTxBaseUrl: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  if (trades.length === 0) {
    return [
      "No active positions.",
      "",
      "Only open orders on markets that have not yet expired appear here.",
      "Completed trades are under /history.",
    ].join("\n");
  }
  return [
    `Active positions (${trades.length}):`,
    "",
    ...trades.map((trade, index) => {
      const body = formatPositionBlock(trade, explorerTxBaseUrl, nowSec);
      return `${index + 1}. ${body}`;
    }),
  ].join("\n\n");
}

export function formatHistoryMessage(
  trades: DisplayTrade[],
  explorerTxBaseUrl: string,
): string {
  if (trades.length === 0) {
    return [
      "No completed trades yet.",
      "",
      "History shows the latest settled, redeemed, cancelled, or failed trades.",
    ].join("\n");
  }
  return [
    `Latest ${trades.length} completed trade${trades.length === 1 ? "" : "s"}:`,
    "",
    ...trades.map((trade, index) => {
      const body = formatHistoryBlock(trade, explorerTxBaseUrl);
      return `${index + 1}. ${body}`;
    }),
  ].join("\n\n");
}

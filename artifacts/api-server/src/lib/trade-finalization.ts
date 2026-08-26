/**
 * Stage 8 — market-resolve finalization for open trades + one-shot Telegram notice claim.
 *
 * Does not place orders. Integrates with existing Stage 6 terminal statuses.
 * PnL/outcome are persisted only when protocol resolution evidence is present.
 */

import type { AppConfig } from "../config.ts";
import {
  classifyOpenTradeFinalization,
  type MarketLifecycleView,
} from "./position-lifecycle.ts";
import {
  computeBinarySettlementPnl,
  mapMarketResolution,
} from "./settlement-pnl.ts";
import { getSupabaseClient } from "./supabase.ts";
import { OPEN_TRADE_STATUSES } from "./trade-state.ts";
import { formatFinalizationMessage } from "./telegram-trade-format.ts";

export type FinalizeTradeRow = {
  id: string;
  userId: string;
  telegramUserId: number | null;
  status: string;
  marketId: string;
  symbol: string;
  direction: string;
  stake: number;
  transactionHash: string | null;
  filledContracts: number | null;
  contracts: number | null;
  errorMessage: string | null;
  outcome: string | null;
  pnl: number | null;
  marketExpiry: string | number | null;
  tradingStart: string | number | null;
  intervalSec: string | number | null;
  finalizationNotifiedAt: string | null;
};

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

function mapFinalizeRow(row: Record<string, unknown>): FinalizeTradeRow {
  const meta = decisionMeta(row.decision);
  const users = row.telegram_users as
    | { telegram_user_id: number }
    | { telegram_user_id: number }[]
    | null;
  const telegramUserId = Array.isArray(users)
    ? (users[0]?.telegram_user_id ?? null)
    : (users?.telegram_user_id ?? null);
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: String(row.id),
    userId: String(row.user_id),
    telegramUserId,
    status: String(row.status),
    marketId: String(row.market_id),
    symbol: String(row.symbol ?? ""),
    direction: String(row.direction ?? ""),
    stake: Number(row.stake_usdso ?? 0),
    transactionHash: (row.transaction_hash as string | null) ?? null,
    filledContracts: num(row.filled_contracts),
    contracts: num(row.contracts),
    errorMessage: (row.error_message as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    pnl: num(row.pnl_usdso),
    marketExpiry: meta.marketExpiry,
    tradingStart: meta.tradingStart,
    intervalSec: meta.intervalSec,
    finalizationNotifiedAt:
      (row.finalization_notified_at as string | null) ?? null,
  };
}

const SELECT =
  "id, user_id, status, market_id, symbol, direction, stake_usdso, transaction_hash, filled_contracts, contracts, error_message, outcome, pnl_usdso, decision, finalization_notified_at, telegram_users(telegram_user_id)";

export async function listOpenTradesForFinalization(
  config: AppConfig,
  options?: { limit?: number },
): Promise<FinalizeTradeRow[]> {
  const limit = options?.limit ?? 50;
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(SELECT)
    .in("status", [...OPEN_TRADE_STATUSES])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error("Unable to list trades for finalization.");
  return (data ?? []).map((row) => mapFinalizeRow(row as Record<string, unknown>));
}

/**
 * Compute outcome/pnl from protocol resolution when available.
 * Returns null fields when evidence is insufficient — does not invent winners.
 */
export function settlementFieldsFromMarket(
  trade: Pick<
    FinalizeTradeRow,
    "direction" | "stake" | "filledContracts" | "contracts"
  >,
  market: MarketLifecycleView | null,
): { outcome: string | null; pnl: number | null; reason?: string } {
  if (!market) {
    return {
      outcome: null,
      pnl: null,
      reason: "No market snapshot; settling status only without inventing PnL.",
    };
  }

  const resolution = mapMarketResolution({
    onchainStatus: market.onchainStatus,
    finalized: market.finalized,
    indexerStatus: market.indexerStatus,
    winningOutcome: market.isVoided
      ? undefined
      : market.winningOutcome,
  });

  // Void via explicit flag even if status enum not yet 5.
  const effective =
    market.isVoided === true
      ? ({ kind: "voided" } as const)
      : market.isResolved === true &&
          (market.winningOutcome === 0 || market.winningOutcome === 1)
        ? ({
            kind: "resolved" as const,
            winner: (market.winningOutcome === 0 ? "up" : "down") as
              | "up"
              | "down",
          })
        : resolution;

  const computed = computeBinarySettlementPnl({
    direction: trade.direction,
    stake: trade.stake,
    filledContracts: trade.filledContracts,
    contracts: trade.contracts,
    resolution: effective,
  });

  if (!computed.ok) {
    return { outcome: null, pnl: null, reason: computed.reason };
  }
  return { outcome: computed.outcome, pnl: computed.pnl };
}

export async function applyMarketResolveFinalization(
  config: AppConfig,
  trade: FinalizeTradeRow,
  market: MarketLifecycleView | null,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<
  | { applied: false; reason: string }
  | {
      applied: true;
      nextStatus: string;
      reason: string;
      outcome: string | null;
      pnl: number | null;
    }
> {
  const decision = classifyOpenTradeFinalization({
    trade: {
      id: trade.id,
      status: trade.status,
      marketId: trade.marketId,
      transactionHash: trade.transactionHash,
      filledContracts: trade.filledContracts,
      marketExpiry: trade.marketExpiry,
    },
    market,
    nowSec,
  });

  if (decision.action === "none") {
    return { applied: false, reason: decision.reason };
  }

  const update: Record<string, unknown> = {
    status: decision.nextStatus,
    error_message:
      decision.nextStatus === "failed" ? decision.reason : trade.errorMessage,
  };

  let outcome: string | null = trade.outcome;
  let pnl: number | null = trade.pnl;

  if (decision.nextStatus === "settled") {
    update.settled_at = new Date().toISOString();
    const settlement = settlementFieldsFromMarket(trade, market);
    if (settlement.outcome !== null) {
      update.outcome = settlement.outcome;
      outcome = settlement.outcome;
    }
    if (settlement.pnl !== null && Number.isFinite(settlement.pnl)) {
      update.pnl_usdso = settlement.pnl;
      pnl = settlement.pnl;
    }
  }
  if (decision.action === "expire_pending") {
    update.reject_reason = decision.reason;
  }

  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .update(update)
    .eq("id", trade.id)
    .eq("user_id", trade.userId)
    .eq("status", trade.status)
    .select("id");

  if (error) throw new Error("Unable to apply market-resolve finalization.");
  if (!Array.isArray(data) || data.length !== 1) {
    return {
      applied: false,
      reason: "Trade status changed concurrently; skipped.",
    };
  }

  return {
    applied: true,
    nextStatus: decision.nextStatus,
    reason: decision.reason,
    outcome,
    pnl,
  };
}

/**
 * Claim the right to send a finalization Telegram notice exactly once.
 * Returns true only for the winner of the conditional update.
 */
export async function claimFinalizationNotification(
  config: AppConfig,
  input: { tradeId: string; userId: string },
): Promise<boolean> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .update({ finalization_notified_at: new Date().toISOString() })
    .eq("id", input.tradeId)
    .eq("user_id", input.userId)
    .is("finalization_notified_at", null)
    .select("id");

  if (error) throw new Error("Unable to claim finalization notification.");
  return Array.isArray(data) && data.length === 1;
}

export async function listTerminalTradesNeedingNotification(
  config: AppConfig,
  options?: { limit?: number },
): Promise<FinalizeTradeRow[]> {
  const limit = options?.limit ?? 50;
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(SELECT)
    .in("status", ["cancelled", "settled", "redeemed", "failed"])
    .is("finalization_notified_at", null)
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error)
    throw new Error("Unable to list terminal trades needing notification.");

  return (data ?? []).map((row) => mapFinalizeRow(row as Record<string, unknown>));
}

export function buildFinalizationTelegramText(
  trade: FinalizeTradeRow,
  explorerTxBaseUrl: string,
): string {
  return formatFinalizationMessage({
    symbol: trade.symbol,
    direction: trade.direction,
    status: trade.status,
    stake: trade.stake,
    outcome: trade.outcome,
    pnl: trade.pnl,
    tradingStart: trade.tradingStart,
    marketExpiry: trade.marketExpiry,
    intervalSec: trade.intervalSec,
    transactionHash: trade.transactionHash,
    errorMessage: trade.errorMessage,
    explorerTxBaseUrl,
  });
}

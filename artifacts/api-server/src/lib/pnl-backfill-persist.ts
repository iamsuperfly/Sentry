/**
 * Persist reconstructed PnL onto settled/redeemed rows that still have null pnl.
 */

import type { AppConfig } from "../config.ts";
import { logger } from "./logger.ts";
import { planPnlBackfill, type PnlBackfillTrade } from "./pnl-backfill.ts";
import type { MarketLifecycleView } from "./position-lifecycle.ts";
import { readResolvedMarketOnchain } from "./resolved-market.ts";
import { getSupabaseClient } from "./supabase.ts";

export async function listSettledTradesMissingPnl(
  config: AppConfig,
  options?: { limit?: number; userId?: string },
): Promise<Array<PnlBackfillTrade & { marketId: string }>> {
  const limit = options?.limit ?? 40;
  let query = getSupabaseClient(config)
    .from("trades")
    .select(
      "id, user_id, status, direction, stake_usdso, filled_contracts, contracts, outcome, pnl_usdso, market_id",
    )
    .in("status", ["settled", "redeemed"])
    .is("pnl_usdso", null)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (options?.userId) query = query.eq("user_id", options.userId);
  const { data, error } = await query;
  if (error) throw new Error("Unable to list settled trades missing PnL.");
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      id: String(r.id),
      userId: String(r.user_id),
      status: String(r.status),
      direction: String(r.direction ?? ""),
      stake: Number(r.stake_usdso ?? 0),
      filledContracts: num(r.filled_contracts),
      contracts: num(r.contracts),
      outcome: (r.outcome as string | null) ?? null,
      pnl: num(r.pnl_usdso),
      marketId: String(r.market_id ?? ""),
    };
  });
}

export async function persistPnlBackfill(
  config: AppConfig,
  trade: PnlBackfillTrade,
  plan: Extract<ReturnType<typeof planPnlBackfill>, { action: "write" }>,
): Promise<boolean> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .update({
      outcome: plan.outcome,
      pnl_usdso: plan.pnl,
    })
    .eq("id", trade.id)
    .eq("user_id", trade.userId)
    .is("pnl_usdso", null)
    .select("id");
  if (error) throw new Error("Unable to persist reconstructed PnL.");
  return Array.isArray(data) && data.length === 1;
}

export async function backfillMissingPnl(config: AppConfig): Promise<number> {
  const rows = await listSettledTradesMissingPnl(config, { limit: 40 });
  let written = 0;
  for (const trade of rows) {
    if (!trade.marketId) continue;
    let market: MarketLifecycleView | null = null;
    try {
      market = await readResolvedMarketOnchain(config, trade.marketId);
    } catch (error) {
      logger.warn(
        {
          tradeId: trade.id,
          marketId: trade.marketId,
          err: error instanceof Error ? error.message.slice(0, 160) : "read failed",
        },
        "PnL backfill market read failed",
      );
      continue;
    }
    const plan = planPnlBackfill(trade, market);
    if (plan.action !== "write") {
      logger.info(
        {
          tradeId: trade.id,
          marketId: trade.marketId,
          resolutionStatus: market?.onchainStatus,
          winningOutcome: market?.winningOutcome ?? null,
          contracts: trade.filledContracts ?? trade.contracts,
          stake: trade.stake,
          reason: plan.reason,
        },
        "PnL backfill skipped",
      );
      continue;
    }
    const ok = await persistPnlBackfill(config, trade, plan);
    if (ok) {
      written += 1;
      logger.info(
        {
          tradeId: trade.id,
          marketId: trade.marketId,
          resolutionStatus: market?.onchainStatus,
          winningOutcome: plan.winningOutcome,
          contracts: trade.filledContracts ?? trade.contracts,
          stake: trade.stake,
          computedPnl: plan.pnl,
          outcome: plan.outcome,
        },
        "PnL reconstructed",
      );
    }
  }
  return written;
}

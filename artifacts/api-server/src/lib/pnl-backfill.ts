/**
 * Reconstruct PnL for settled rows missing pnl_usdso using on-chain resolution.
 * Reuses computeBinarySettlementPnl — never invents a winner.
 */

import {
  computeBinarySettlementPnl,
  mapMarketResolution,
  type MarketResolution,
} from "./settlement-pnl.ts";
import type { MarketLifecycleView } from "./position-lifecycle.ts";

export type PnlBackfillTrade = {
  id: string;
  userId: string;
  status: string;
  direction: string;
  stake: number;
  filledContracts: number | null;
  contracts: number | null;
  outcome: string | null;
  pnl: number | null;
};

export type PnlBackfillPlan =
  | { action: "none"; reason: string }
  | {
      action: "write";
      outcome: string;
      pnl: number;
      resolutionKind: string;
      winningOutcome: number | null;
      reason: string;
    };

export function planPnlBackfill(
  trade: PnlBackfillTrade,
  market: MarketLifecycleView | null,
): PnlBackfillPlan {
  if (trade.status !== "settled" && trade.status !== "redeemed") {
    return { action: "none", reason: `Status ${trade.status} is not settled/redeemed.` };
  }
  if (trade.pnl !== null && Number.isFinite(trade.pnl)) {
    return { action: "none", reason: "PnL already reconstructed." };
  }
  if (!market) {
    return { action: "none", reason: "No finalized/on-chain market snapshot." };
  }

  const resolution: MarketResolution = market.isVoided
    ? { kind: "voided" }
    : market.isResolved === true &&
        (market.winningOutcome === 0 || market.winningOutcome === 1)
      ? {
          kind: "resolved",
          winner: market.winningOutcome === 0 ? "up" : "down",
        }
      : mapMarketResolution({
          onchainStatus: market.onchainStatus,
          finalized: market.finalized,
          indexerStatus: market.indexerStatus,
          winningOutcome: market.winningOutcome,
        });

  const computed = computeBinarySettlementPnl({
    direction: trade.direction,
    stake: trade.stake,
    filledContracts: trade.filledContracts,
    contracts: trade.contracts,
    resolution,
  });

  if (!computed.ok) {
    return { action: "none", reason: computed.reason };
  }

  return {
    action: "write",
    outcome: computed.outcome,
    pnl: computed.pnl,
    resolutionKind: resolution.kind,
    winningOutcome:
      market.winningOutcome === 0 || market.winningOutcome === 1
        ? market.winningOutcome
        : null,
    reason: "Reconstructed from on-chain/finalized resolution.",
  };
}

/**
 * Pure position lifecycle rules for Telegram UX + finalization.
 * Uses market expiry / finalized flags — not a fabricated "expired" DB status.
 */

import { OPEN_TRADE_STATUSES, isOpenTradeStatus } from "./trade-state.ts";
import { parseUnixSeconds } from "./telegram-trade-format.ts";

export type MarketLifecycleView = {
  marketId: string;
  expiry: string | number;
  finalized?: boolean;
  indexerStatus?: string;
  tradable?: boolean;
  onchainStatus?: number;
  tradingStart?: string | number | null;
};

export type OpenTradeLifecycleView = {
  id: string;
  status: string;
  marketId: string;
  transactionHash: string | null;
  filledContracts: number | null;
  /** Prefer decision/market expiry when present. */
  marketExpiry?: string | number | null;
};

/**
 * Market is past resolution window when expiry ≤ now, or protocol marks finalized.
 */
export function isMarketResolved(
  market: Pick<
    MarketLifecycleView,
    "expiry" | "finalized" | "indexerStatus"
  >,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (market.finalized === true) return true;
  if (market.indexerStatus === "Finalized") return true;
  const expiry = parseUnixSeconds(market.expiry);
  if (expiry !== null && expiry <= nowSec) return true;
  return false;
}

/**
 * Active display rule: open order status AND market still not resolved.
 * Filled orders on an expired market must leave /positions.
 */
export function shouldShowInPositions(input: {
  status: string;
  marketExpiry?: string | number | null;
  market?: MarketLifecycleView | null;
  nowSec?: number;
}): boolean {
  if (!isOpenTradeStatus(input.status)) return false;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);

  if (input.market) {
    if (isMarketResolved(input.market, nowSec)) return false;
    return true;
  }

  const expiry = parseUnixSeconds(input.marketExpiry ?? null);
  if (expiry !== null && expiry <= nowSec) return false;
  // Without market or expiry metadata, keep open statuses visible (safe default).
  return true;
}

export type FinalizationAction =
  | {
      action: "none";
      reason: string;
    }
  | {
      action: "expire_pending";
      nextStatus: "failed";
      reason: string;
    }
  | {
      action: "settle_filled";
      nextStatus: "settled";
      reason: string;
    }
  | {
      action: "fail_submitted";
      nextStatus: "failed";
      reason: string;
    };

/**
 * Decide how an open trade should move when its market is resolved.
 * Does not place orders. Does not invent PnL.
 */
export function classifyOpenTradeFinalization(input: {
  trade: OpenTradeLifecycleView;
  market?: MarketLifecycleView | null;
  nowSec?: number;
}): FinalizationAction {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const status = input.trade.status;

  if (!(OPEN_TRADE_STATUSES as readonly string[]).includes(status)) {
    return { action: "none", reason: `Status ${status} is already terminal or unknown.` };
  }

  const resolvedViaMarket =
    input.market !== null &&
    input.market !== undefined &&
    isMarketResolved(input.market, nowSec);
  const expiry = parseUnixSeconds(
    input.trade.marketExpiry ?? input.market?.expiry ?? null,
  );
  const resolvedViaExpiry = expiry !== null && expiry <= nowSec;

  if (!resolvedViaMarket && !resolvedViaExpiry) {
    return { action: "none", reason: "Market is still active." };
  }

  if (status === "pending") {
    if (input.trade.transactionHash || (input.trade.filledContracts ?? 0) > 0) {
      return {
        action: "none",
        reason:
          "Pending row has broadcast/fill evidence; leave for submission reconciliation.",
      };
    }
    return {
      action: "expire_pending",
      nextStatus: "failed",
      reason:
        "Pending intent expired or its market is no longer tradable; no transaction or fill was recorded.",
    };
  }

  if (status === "submitted") {
    // Still waiting on receipt path — do not invent a fill; mark failed only when
    // market is gone and there is no hash (uncertain broadcast already annotated).
    if (!input.trade.transactionHash) {
      return {
        action: "fail_submitted",
        nextStatus: "failed",
        reason:
          "Market resolved while trade was submitted without a confirmed receipt.",
      };
    }
    return {
      action: "none",
      reason:
        "Submitted trade still has a hash; Stage 6 receipt reconciliation owns the next transition.",
    };
  }

  if (status === "partially_filled" || status === "filled") {
    return {
      action: "settle_filled",
      nextStatus: "settled",
      reason: "Market resolved after fill; position moves to terminal settled state.",
    };
  }

  return { action: "none", reason: "No finalization action." };
}

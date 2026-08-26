/**
 * Attach market window metadata from DreamDEX diagnostics onto a strategy decision
 * before persistence so Telegram can show real timeframes (5m / 30m / 1h).
 *
 * Source of truth: BinaryMarket.tradingStart + BinaryMarket.expiry from the indexer
 * (already exposed on DreamdexMarketDiagnostic).
 */

import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";
import type { StrategyDecision } from "./strategy.ts";

export type DecisionWithMarketWindow = StrategyDecision & {
  /** Indexer trading window start (unix sec or ms string). */
  tradingStart: string;
};

export function attachMarketWindowMeta(
  decision: StrategyDecision,
  markets: ReadonlyArray<DreamdexMarketDiagnostic>,
): DecisionWithMarketWindow {
  const market = markets.find((m) => m.marketId === decision.marketId);
  const tradingStart =
    market?.tradingStart ??
    (decision as { tradingStart?: string }).tradingStart ??
    "";
  return {
    ...decision,
    tradingStart,
    // Prefer market expiry when present (same as decision.expiry from strategy).
    expiry: market?.expiry ?? decision.expiry,
  };
}

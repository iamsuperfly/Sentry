/**
 * Attach market window metadata from DreamDEX diagnostics onto a strategy decision
 * before persistence so Telegram can show real timeframes (5m / 30m / 1h).
 *
 * Source of truth (in priority order):
 * 1. BinaryMarket.intervalSec when present (SDK-derived window length)
 * 2. BinaryMarket.tradingStart + BinaryMarket.expiry duration
 *
 * Does NOT infer timeframe from when the user placed the trade.
 */

import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";
import type { StrategyDecision } from "./strategy.ts";

export type DecisionWithMarketWindow = StrategyDecision & {
  /** Indexer trading window start (unix sec string). */
  tradingStart: string;
  /** Window length in seconds when known (from intervalSec or start→expiry). */
  intervalSec: string | null;
};

export function attachMarketWindowMeta(
  decision: StrategyDecision,
  markets: ReadonlyArray<DreamdexMarketDiagnostic>,
): DecisionWithMarketWindow {
  const market = markets.find((m) => m.marketId === decision.marketId);
  const existing = decision as {
    tradingStart?: string;
    intervalSec?: string | null;
  };
  const tradingStart =
    market?.tradingStart ?? existing.tradingStart ?? "";
  const intervalSec =
    market?.intervalSec ??
    existing.intervalSec ??
    null;
  return {
    ...decision,
    tradingStart,
    intervalSec,
    // Prefer market expiry when present (same as decision.expiry from strategy).
    expiry: market?.expiry ?? decision.expiry,
  };
}

/** Pure: duration seconds for display, prefer intervalSec then start→expiry. */
export function resolveMarketDurationSeconds(meta: {
  intervalSec?: string | number | null;
  tradingStart?: string | number | null;
  expiry?: string | number | null;
}): number | null {
  if (
    meta.intervalSec !== null &&
    meta.intervalSec !== undefined &&
    meta.intervalSec !== ""
  ) {
    const n = Number(meta.intervalSec);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const start = Number(meta.tradingStart);
  const end = Number(meta.expiry);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const startSec = start >= 1e12 ? start / 1000 : start;
  const endSec = end >= 1e12 ? end / 1000 : end;
  const duration = endSec - startSec;
  return duration > 0 && Number.isFinite(duration) ? duration : null;
}

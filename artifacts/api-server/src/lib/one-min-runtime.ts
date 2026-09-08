/**
 * Runtime glue: Binance sampler prints → 1m vote.
 * Fail closed if the sampler does not have five usable prices.
 */

import { listObservations } from "./binance-sampler.ts";
import {
  evaluateOneMinuteVote,
  ONE_MIN_MIN_SECONDS_TO_EXPIRY,
  ONE_MIN_STRATEGY_NAME,
  type OneMinDecision,
} from "./strategy-1m.ts";
import { classifyMarketDuration } from "./market-duration.ts";
import {
  extractBookTop,
  secondsToExpiry,
  type StrategyDecision,
} from "./strategy.ts";
import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";

export function isOneMinuteMarket(market: DreamdexMarketDiagnostic): boolean {
  const { bucket } = classifyMarketDuration({
    intervalSec: market.intervalSec,
    tradingStart: market.tradingStart,
    expiry: market.expiry,
  });
  return bucket === "1m";
}

export function marketEligibleForOneMin(
  market: DreamdexMarketDiagnostic,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!market.tradable || market.finalized) return false;
  if (!isOneMinuteMarket(market)) return false;
  const left = secondsToExpiry(market.expiry, nowSec);
  return left !== null && left >= ONE_MIN_MIN_SECONDS_TO_EXPIRY;
}

/** @deprecated Use marketEligibleForOneMin (left >= 30). */
export function marketInOneMinFinalWindow(
  market: DreamdexMarketDiagnostic,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  return marketEligibleForOneMin(market, nowSec);
}

export async function evaluateOneMinMarketWithBinance(input: {
  market: DreamdexMarketDiagnostic;
  nowSec?: number;
}): Promise<{
  decision: OneMinDecision;
  prices: number[];
}> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const left = secondsToExpiry(input.market.expiry, nowSec);
  if (!marketEligibleForOneMin(input.market, nowSec)) {
    return {
      decision: evaluateOneMinuteVote({
        secondsToExpiry: left,
        prices: [],
      }),
      prices: [],
    };
  }

  const prices = listObservations(input.market.asset).map((row) => row.price);
  const decision = evaluateOneMinuteVote({
    secondsToExpiry: left,
    prices,
  });
  return { decision, prices };
}

export function oneMinEnterToStrategyDecision(input: {
  market: DreamdexMarketDiagnostic;
  oneMin: Extract<OneMinDecision, { action: "enter" }>;
  nowSec?: number;
}): StrategyDecision | null {
  const market = input.market;
  const book = extractBookTop(market);
  const direction = input.oneMin.direction === "UP" ? "YES" : "NO";
  const limitPriceHint = direction === "YES" ? book.yesAsk : book.noAsk;
  if (limitPriceHint === null || limitPriceHint <= 0 || limitPriceHint >= 1) {
    return null;
  }
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const left = secondsToExpiry(market.expiry, nowSec);
  return {
    strategyName: ONE_MIN_STRATEGY_NAME,
    strategyVersion: "1.0.0",
    action: "enter",
    marketId: market.marketId,
    asset: market.asset,
    marketAddress: market.marketAddress,
    poolAddress: market.poolAddress,
    poolNonce: market.poolNonce,
    expiry: market.expiry,
    direction,
    limitPriceHint,
    edge: null,
    edgeThreshold: 0,
    fairProbability: 0.5,
    book,
    secondsToExpiry: left,
    tradable: market.tradable,
    finalized: market.finalized,
    indexerStatus: String(market.indexerStatus),
    onchainStatus: market.onchainStatus,
    reason: input.oneMin.reason,
    skipCode: null,
  };
}

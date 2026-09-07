/**
 * Runtime glue: Binance spot prices → pure 1m ±0.05% strategy.
 * Reference price is fixed for the market once set in the final window.
 */

import { fetchBinanceSpotPrice } from "./binance-spot.ts";
import {
  getCachedSpotQuote,
  listObservations,
} from "./binance-sampler.ts";
import {
  evaluateOneMinuteUnderlying,
  ONE_MIN_FINAL_WINDOW_SEC,
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

const ONE_MIN_MOVE_DISPLAY = 0.0005;

/** In-process reference prices for 1m final window (not reset mid-window). */
const referenceByMarket = new Map<
  string,
  { price: number; setAtMs: number }
>();

export function clearOneMinReferencesForTests(): void {
  referenceByMarket.clear();
}

export function getOneMinReference(marketId: string): number | null {
  return referenceByMarket.get(marketId)?.price ?? null;
}

export function setOneMinReference(
  marketId: string,
  price: number,
  nowMs: number = Date.now(),
): void {
  if (!referenceByMarket.has(marketId)) {
    referenceByMarket.set(marketId, { price, setAtMs: nowMs });
  }
}

export function isOneMinuteMarket(market: DreamdexMarketDiagnostic): boolean {
  const { bucket } = classifyMarketDuration({
    intervalSec: market.intervalSec,
    tradingStart: market.tradingStart,
    expiry: market.expiry,
  });
  return bucket === "1m";
}

export function marketInOneMinFinalWindow(
  market: DreamdexMarketDiagnostic,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!market.tradable || market.finalized) return false;
  if (!isOneMinuteMarket(market)) return false;
  const left = secondsToExpiry(market.expiry, nowSec);
  return left !== null && left > 0 && left <= ONE_MIN_FINAL_WINDOW_SEC;
}

/**
 * Cache-first 1m evaluation. Live ticker is only a fallback when the sampler is empty/stale.
 * Does not reset an existing reference for the same marketId.
 */
export async function evaluateOneMinMarketWithBinance(input: {
  market: DreamdexMarketDiagnostic;
  nowSec?: number;
  fetchImpl?: typeof fetch;
  sampleGapMs?: number;
}): Promise<{
  decision: OneMinDecision;
  referencePrice: number | null;
  currentPrice: number | null;
}> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const left = secondsToExpiry(input.market.expiry, nowSec);
  if (!marketInOneMinFinalWindow(input.market, nowSec)) {
    return {
      decision: evaluateOneMinuteUnderlying({
        secondsToExpiry: left,
        referencePrice: null,
        currentPrice: null,
      }),
      referencePrice: null,
      currentPrice: null,
    };
  }

  const nowMs = Date.now();
  const cached = getCachedSpotQuote(input.market.asset, nowMs);
  const history = listObservations(input.market.asset);

  let currentPrice: number | null = cached?.price ?? null;
  let seedPrice: number | null = null;
  if (history.length >= 2) {
    seedPrice = history[0]!.price;
  }

  if (currentPrice === null) {
    const live = await fetchBinanceSpotPrice({
      asset: input.market.asset,
      fetchImpl: input.fetchImpl,
    });
    if (!live.ok) {
      return {
        decision: {
          action: "skip",
          code: live.code,
          reason: live.reason,
          secondsToExpiry: left ?? undefined,
        },
        referencePrice: null,
        currentPrice: null,
      };
    }
    currentPrice = live.quote.price;
    if (seedPrice === null) seedPrice = live.quote.price;
  }

  if (getOneMinReference(input.market.marketId) === null && seedPrice !== null) {
    setOneMinReference(input.market.marketId, seedPrice);
  }
  const referencePrice = getOneMinReference(input.market.marketId);

  if (referencePrice === null || currentPrice === null) {
    return {
      decision: {
        action: "skip",
        code: "binance_stale",
        reason: "No fresh Binance observation for 1m evaluation.",
        secondsToExpiry: left ?? undefined,
      },
      referencePrice,
      currentPrice,
    };
  }

  const decision = evaluateOneMinuteUnderlying({
    secondsToExpiry: left,
    referencePrice,
    currentPrice,
  });
  return {
    decision,
    referencePrice,
    currentPrice,
  };
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
    edge: ONE_MIN_MOVE_DISPLAY,
    edgeThreshold: 0.0005,
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

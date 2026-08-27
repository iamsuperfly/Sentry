/**
 * Runtime glue: Binance spot prices → pure 1m ±0.05% strategy.
 * Reference price is fixed for the market once set in the final window.
 */

import { fetchBinanceSpotPrice } from "./binance-spot.ts";
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
 * Dual-sample within one cycle: fix reference from first tick, current from second.
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

  const first = await fetchBinanceSpotPrice({
    asset: input.market.asset,
    fetchImpl: input.fetchImpl,
  });
  if (!first.ok) {
    return {
      decision: {
        action: "skip",
        code: first.code,
        reason: first.reason,
        secondsToExpiry: left ?? undefined,
      },
      referencePrice: null,
      currentPrice: null,
    };
  }

  if (getOneMinReference(input.market.marketId) === null) {
    setOneMinReference(input.market.marketId, first.quote.price);
  }
  const referencePrice = getOneMinReference(input.market.marketId);

  const gap = input.sampleGapMs ?? 800;
  if (gap > 0) {
    await new Promise((r) => setTimeout(r, gap));
  }

  const second = await fetchBinanceSpotPrice({
    asset: input.market.asset,
    fetchImpl: input.fetchImpl,
  });
  if (!second.ok) {
    return {
      decision: {
        action: "skip",
        code: second.code,
        reason: second.reason,
        referencePrice: referencePrice ?? undefined,
        secondsToExpiry: left ?? undefined,
      },
      referencePrice,
      currentPrice: null,
    };
  }

  const decision = evaluateOneMinuteUnderlying({
    secondsToExpiry: left,
    referencePrice,
    currentPrice: second.quote.price,
  });
  return {
    decision,
    referencePrice,
    currentPrice: second.quote.price,
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

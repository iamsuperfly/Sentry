/**
 * AI → StrategyDecision mapping for 5m (final 120s) and 15m+ markets.
 * Pure helpers + orchestration-facing adapters. No secrets.
 */

import { classifyMarketDuration } from "./market-duration.ts";
import type { GeminiMarketInput } from "./gemini-client.ts";
import {
  extractBookTop,
  secondsToExpiry,
  type StrategyDecision,
  type BookTop,
} from "./strategy.ts";
import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";

export const GEMINI_STRATEGY_NAME = "gemini-v1";
export const GEMINI_STRATEGY_VERSION = "1.0.0";

export const FIVE_MIN_AI_WINDOW_SEC = 120;

/** Durations that use Groq/AI as the decision engine. */
export const GEMINI_DURATION_BUCKETS = new Set([
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
]);

export function isGeminiDurationBucket(bucket: string): boolean {
  return GEMINI_DURATION_BUCKETS.has(bucket);
}

export function marketEligibleForGemini(
  market: DreamdexMarketDiagnostic,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!market.tradable || market.finalized) return false;
  const { bucket } = classifyMarketDuration({
    intervalSec: market.intervalSec,
    tradingStart: market.tradingStart,
    expiry: market.expiry,
  });
  if (!isGeminiDurationBucket(bucket)) return false;
  const left = secondsToExpiry(market.expiry, nowSec);
  if (left === null || left <= 60) return false;
  if (bucket === "5m" && left > FIVE_MIN_AI_WINDOW_SEC) return false;
  const book = extractBookTop(market);
  return book.yesAsk !== null || book.noAsk !== null;
}

export function toGeminiMarketInput(
  market: DreamdexMarketDiagnostic,
  nowSec: number = Math.floor(Date.now() / 1000),
): GeminiMarketInput {
  const classified = classifyMarketDuration({
    intervalSec: market.intervalSec,
    tradingStart: market.tradingStart,
    expiry: market.expiry,
  });
  const book = extractBookTop(market);
  const left = secondsToExpiry(market.expiry, nowSec);
  const spread =
    book.yesBid !== null && book.yesAsk !== null
      ? book.yesAsk - book.yesBid
      : null;
  return {
    marketId: market.marketId,
    asset: market.asset,
    question: market.question,
    strike: market.strike,
    durationBucket: classified.bucket,
    intervalSec: classified.intervalSec,
    windowSec: classified.windowSec,
    tradingStart: market.tradingStart,
    expiry: market.expiry,
    secondsToExpiry: left,
    tradable: market.tradable,
    finalized: market.finalized,
    yesBid: book.yesBid,
    yesAsk: book.yesAsk,
    noBid: book.noBid,
    noAsk: book.noAsk,
    spread,
    topAskQuantity: null,
  };
}

export function geminiCandidateToStrategyDecision(input: {
  candidate: {
    marketId: string;
    direction: "UP" | "DOWN";
    confidence: number;
    reason: string;
    stake: number;
  };
  market: DreamdexMarketDiagnostic;
  nowSec?: number;
}): StrategyDecision | null {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const market = input.market;
  const book = extractBookTop(market);
  const direction = input.candidate.direction === "UP" ? "YES" : "NO";
  const limitPriceHint = direction === "YES" ? book.yesAsk : book.noAsk;
  if (limitPriceHint === null || limitPriceHint <= 0 || limitPriceHint >= 1) {
    return null;
  }
  const left = secondsToExpiry(market.expiry, nowSec);
  return {
    strategyName: GEMINI_STRATEGY_NAME,
    strategyVersion: GEMINI_STRATEGY_VERSION,
    action: "enter",
    marketId: market.marketId,
    asset: market.asset,
    marketAddress: market.marketAddress,
    poolAddress: market.poolAddress,
    poolNonce: market.poolNonce,
    expiry: market.expiry,
    direction,
    limitPriceHint,
    edge: input.candidate.confidence,
    edgeThreshold: 0,
    fairProbability: 0.5,
    book,
    secondsToExpiry: left,
    tradable: market.tradable,
    finalized: market.finalized,
    indexerStatus: String(market.indexerStatus),
    onchainStatus: market.onchainStatus,
    reason: `gemini confidence=${input.candidate.confidence}: ${input.candidate.reason}`.slice(
      0,
      500,
    ),
    skipCode: null,
  };
}

export function emptyBookTop(): BookTop {
  return { yesBid: null, yesAsk: null, noBid: null, noAsk: null };
}

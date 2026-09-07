/**
 * Groq → StrategyDecision mapping for 5m and 15m+ markets.
 * Pure helpers + orchestration-facing adapters. No secrets.
 *
 * Historical note: this module was originally written for Gemini. The live
 * decision provider is Groq; the mapping contract is unchanged.
 */

import { classifyMarketDuration } from "./market-duration.ts";
import type { AiMarketInput } from "./groq-client.ts";
import {
  extractBookTop,
  secondsToExpiry,
  type StrategyDecision,
} from "./strategy.ts";
import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";
import { referencePriceForMarket } from "./reference-price.ts";

function levelQuantity(
  levels: Array<{ quantity: string }> | undefined,
  decimals: number,
): number | null {
  const raw = levels?.[0]?.quantity;
  if (raw === undefined) return null;
  const scale = 10 ** decimals;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const value = Number(raw) / scale;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const GROQ_STRATEGY_NAME = "groq-v1";
export const GROQ_STRATEGY_VERSION = "1.0.0";

/** Durations that use Groq as the decision engine. */
export const GROQ_DURATION_BUCKETS = new Set([
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
]);

export function isGroqDurationBucket(bucket: string): boolean {
  return GROQ_DURATION_BUCKETS.has(bucket);
}

export function marketEligibleForGroq(
  market: DreamdexMarketDiagnostic,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!market.tradable || market.finalized) return false;
  const { bucket } = classifyMarketDuration({
    intervalSec: market.intervalSec,
    tradingStart: market.tradingStart,
    expiry: market.expiry,
  });
  if (!isGroqDurationBucket(bucket)) return false;
  if (referencePriceForMarket(market) === null) return false;
  const left = secondsToExpiry(market.expiry, nowSec);
  if (left === null || left <= 0) return false;
  if (bucket !== "5m" && left <= 60) return false;
  const book = extractBookTop(market);
  return book.yesAsk !== null || book.noAsk !== null;
}

export function toGroqMarketInput(
  market: DreamdexMarketDiagnostic,
  nowSec: number = Math.floor(Date.now() / 1000),
): AiMarketInput {
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
  const yesAskQuantity = levelQuantity(market.book.yesAsks, market.decimals);
  const noAskQuantity = levelQuantity(market.book.noAsks, market.decimals);
  const topAskQuantity = Math.max(
    yesAskQuantity ?? 0,
    noAskQuantity ?? 0,
  );
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
    referenceType:
      market.referenceType ??
      (market.strike === "0" ? undefined : "strike"),
    referencePrice: referencePriceForMarket(market) ?? undefined,
    referenceDecimals: market.referenceDecimals,
    secondsToExpiry: left,
    tradable: market.tradable,
    finalized: market.finalized,
    yesBid: book.yesBid,
    yesAsk: book.yesAsk,
    noBid: book.noBid,
    noAsk: book.noAsk,
    spread,
    topAskQuantity: topAskQuantity > 0 ? topAskQuantity : null,
    yesAskQuantity,
    noAskQuantity,
  };
}

export function groqCandidateToStrategyDecision(input: {
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
    strategyName: GROQ_STRATEGY_NAME,
    strategyVersion: GROQ_STRATEGY_VERSION,
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
    reason: `groq confidence=${input.candidate.confidence}: ${input.candidate.reason}`.slice(
      0,
      500,
    ),
    skipCode: null,
  };
}

/**
 * AI → StrategyDecision mapping for 5m and 15m+ markets.
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

export const GEMINI_STRATEGY_NAME = "gemini-v1";
export const GEMINI_STRATEGY_VERSION = "1.0.0";

/** @deprecated 5m markets are no longer gated to a final-120s window. */
export const FIVE_MIN_AI_WINDOW_SEC = 120;

/** Durations that use Groq/AI as the decision engine. */
export const GEMINI_DURATION_BUCKETS = new Set([
  "5m",
  "15m",
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
  if (referencePriceForMarket(market) === null) return false;
  const left = secondsToExpiry(market.expiry, nowSec);
  if (left === null || left <= 0) return false;
  if (bucket !== "5m" && left <= 60) return false;
  const book = extractBookTop(market);
  return book.yesAsk !== null || book.noAsk !== null;
}

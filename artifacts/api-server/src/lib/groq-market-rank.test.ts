import assert from "node:assert/strict";
import test from "node:test";
import type { GroqRankMarket } from "./groq-market-rank.ts";
import {
  compactAiMarket,
  rankMarketsForGroq,
  resolveGroqMarketCap,
} from "./groq-market-rank.ts";

function m(over: Partial<GroqRankMarket> = {}): GroqRankMarket {
  return {
    marketId: over.marketId ?? "m",
    asset: "BTC",
    durationBucket: "15m",
    secondsToExpiry: 400,
    yesAsk: 0.52,
    noAsk: 0.51,
    spread: 0.04,
    topAskQuantity: 20,
    ...over,
  };
}

test("cap is configurable and bounded", () => {
  assert.equal(resolveGroqMarketCap(undefined), 8);
  assert.equal(resolveGroqMarketCap("12"), 12);
  assert.equal(resolveGroqMarketCap(99), 24);
});

test("ranks healthier books above dying or wide markets", () => {
  const ranked = rankMarketsForGroq(
    [
      m({ marketId: "dying", secondsToExpiry: 40, spread: 0.02 }),
      m({ marketId: "wide", spread: 0.2, secondsToExpiry: 500 }),
      m({ marketId: "good", spread: 0.02, secondsToExpiry: 500, topAskQuantity: 50 }),
    ],
    2,
  );
  assert.equal(ranked[0]?.marketId, "good");
  assert.equal(ranked.length, 2);
});

test("compact payload drops verbose unused fields", () => {
  const row = compactAiMarket(m());
  assert.equal(row.id, "m");
  assert.equal(row.a, "BTC");
  assert.equal(row.question, undefined);
});

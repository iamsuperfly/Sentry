import assert from "node:assert/strict";
import test from "node:test";
import { prepareGroqMarkets } from "./groq-prompt.ts";
import {
  calculateGapBps,
  enrichGroqMarketWithSpot,
  fetchGroqSpotQuotes,
  parseMarketStrike,
} from "./groq-market-context.ts";
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
  const row = compactAiMarket(
    m({
      strike: "68000",
      spot: 68100,
      gapBps: 14.71,
      yesAskQuantity: 12,
      noAskQuantity: 8,
    }),
  );
  assert.equal(row.id, "m");
  assert.equal(row.a, "BTC");
  assert.equal(row.question, undefined);
  assert.equal(row.strike, "68000");
  assert.equal(row.spot, 68100);
  assert.equal(row.gapBps, 14.71);
  assert.deepEqual(row.depth, { yes: 12, no: 8 });
});

test("extracts contract strikes and calculates signed gap basis points", () => {
  assert.equal(parseMarketStrike("68000"), 68000);
  assert.equal(parseMarketStrike(""), null);
  assert.equal(parseMarketStrike("not-a-strike"), null);
  assert.equal(calculateGapBps(68100, 68000), 14.71);
  assert.equal(calculateGapBps(67900, 68000), -14.71);
});

test("enriches BTC and ETH markets without inventing missing strike context", () => {
  const btc = enrichGroqMarketWithSpot(
    m({ asset: "BTC", strike: "68000" }),
    {
      ok: true,
      quote: {
        provider: "binance",
        symbol: "BTCUSDT",
        asset: "BTC",
        price: 68100,
        fetchedAtMs: 1,
      },
    },
  );
  const eth = enrichGroqMarketWithSpot(
    m({ asset: "ETH", strike: "3500" }),
    {
      ok: true,
      quote: {
        provider: "binance",
        symbol: "ETHUSDT",
        asset: "ETH",
        price: 3493,
        fetchedAtMs: 1,
      },
    },
  );
  const missingStrike = enrichGroqMarketWithSpot(
    m({ asset: "BTC", strike: undefined }),
    btc.spot === undefined
      ? undefined
      : {
          ok: true,
          quote: {
            provider: "binance",
            symbol: "BTCUSDT",
            asset: "BTC",
            price: btc.spot,
            fetchedAtMs: 1,
          },
        },
  );

  assert.equal(btc.spot, 68100);
  assert.equal(btc.gapBps, 14.71);
  assert.equal(eth.spot, 3493);
  assert.equal(eth.gapBps, -20);
  assert.equal(missingStrike.spot, 68100);
  assert.equal(missingStrike.gapBps, undefined);

  const opening = enrichGroqMarketWithSpot(
    m({
      asset: "BTC",
      strike: "0",
      referenceType: "opening",
      referencePrice: 80_346.7,
      referenceDecimals: 2,
    }),
    {
      ok: true,
      quote: {
        provider: "binance",
        symbol: "BTCUSDT",
        asset: "BTC",
        price: 80_750,
        fetchedAtMs: 1,
      },
    },
  );
  assert.equal(opening.spot, 80_750);
  assert.equal(opening.gapBps, 50.19);
});

test("fetches one quote per unique supported asset and fails closed per asset", async () => {
  const calls: string[] = [];
  const quotes = await fetchGroqSpotQuotes(
    [
      { asset: "BTC" },
      { asset: "btc" },
      { asset: "ETH" },
      { asset: "SOL" },
    ],
    {
      fetchImpl: async (url) => {
        const urlString = String(url);
        calls.push(urlString);
        const price = urlString.includes("BTCUSDT") ? "68100" : "3493";
        return new Response(JSON.stringify({ price }), { status: 200 });
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(quotes.get("BTC")?.ok, true);
  assert.equal(quotes.get("ETH")?.ok, true);
  assert.equal(quotes.has("SOL"), false);

  const failed = await fetchGroqSpotQuotes([{ asset: "BTC" }], {
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  const failedContext = enrichGroqMarketWithSpot(
    m({ asset: "BTC", strike: "68000" }),
    failed.get("BTC"),
  );
  assert.equal(failed.get("BTC")?.ok, false);
  assert.equal(failedContext.spot, undefined);
  assert.equal(failedContext.gapBps, undefined);

  const timedOut = await fetchGroqSpotQuotes([{ asset: "ETH" }], {
    fetchImpl: async () => {
      const error = new Error("timeout");
      error.name = "AbortError";
      throw error;
    },
  });
  assert.equal(timedOut.get("ETH")?.ok, false);
  if (timedOut.get("ETH")?.ok === false) {
    assert.equal(timedOut.get("ETH")?.code, "binance_timeout");
  }
});

test("keeps the configured Groq cap while adding compact underlying fields", () => {
  const markets = Array.from({ length: 10 }, (_, index) =>
    m({
      marketId: `m-${index}`,
      strike: "68000",
      spot: 68100,
      gapBps: 14.71,
    }),
  );
  const prepared = prepareGroqMarkets(markets, 2, 8);

  assert.equal(prepared.cap, 8);
  assert.equal(prepared.selected.length, 8);
  assert.match(prepared.prompt, /"spot":68100/);
  assert.match(prepared.prompt, /"strike":"68000"/);
  assert.match(prepared.prompt, /"gapBps":14\.71/);
});

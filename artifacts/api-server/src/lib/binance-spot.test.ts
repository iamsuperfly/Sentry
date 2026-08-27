import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  binanceSymbolForAsset,
  fetchBinanceSpotPrice,
  isQuoteFresh,
} from "./binance-spot.ts";

describe("binance public spot feed", () => {
  it("maps BTC/ETH to USDT symbols", () => {
    assert.equal(binanceSymbolForAsset("BTC"), "BTCUSDT");
    assert.equal(binanceSymbolForAsset("eth"), "ETHUSDT");
    assert.equal(binanceSymbolForAsset("SOL"), null);
  });

  it("parses BTCUSDT ticker from mock response", async () => {
    const r = await fetchBinanceSpotPrice({
      asset: "BTC",
      fetchImpl: async () =>
        new Response(JSON.stringify({ symbol: "BTCUSDT", price: "65000.12" }), {
          status: 200,
        }),
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.quote.symbol, "BTCUSDT");
      assert.equal(r.quote.price, 65000.12);
      assert.equal(r.quote.provider, "binance");
    }
  });

  it("parses ETHUSDT ticker from mock response", async () => {
    const r = await fetchBinanceSpotPrice({
      asset: "ETH",
      fetchImpl: async () =>
        new Response(JSON.stringify({ symbol: "ETHUSDT", price: "3200.5" }), {
          status: 200,
        }),
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.quote.price, 3200.5);
  });

  it("rejects invalid price", async () => {
    const r = await fetchBinanceSpotPrice({
      asset: "BTC",
      fetchImpl: async () =>
        new Response(JSON.stringify({ symbol: "BTCUSDT", price: "0" }), {
          status: 200,
        }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "binance_invalid_price");
  });

  it("maps HTTP errors", async () => {
    const r = await fetchBinanceSpotPrice({
      asset: "BTC",
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "binance_http_error");
  });

  it("detects stale quotes", () => {
    const now = Date.now();
    assert.equal(
      isQuoteFresh(
        {
          provider: "binance",
          symbol: "BTCUSDT",
          asset: "BTC",
          price: 1,
          fetchedAtMs: now - 10_000,
        },
        now,
        3_000,
      ),
      false,
    );
    assert.equal(
      isQuoteFresh(
        {
          provider: "binance",
          symbol: "BTCUSDT",
          asset: "BTC",
          price: 1,
          fetchedAtMs: now - 500,
        },
        now,
        3_000,
      ),
      true,
    );
  });
});

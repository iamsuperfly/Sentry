import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveBinanceFeatures,
  featuresForDuration,
  type PriceObservation,
} from "./binance-features.ts";
import {
  getCachedSpotQuote,
  getBinanceFeatureSnapshot,
  recordObservation,
  resetBinanceSamplerForTests,
} from "./binance-sampler.ts";

function obs(
  asset: string,
  price: number,
  observedAtMs: number,
): PriceObservation {
  return { asset, price, observedAtMs };
}

test("deriveBinanceFeatures marks stale history and nulls moves", () => {
  const now = 1_000_000;
  const snapshot = deriveBinanceFeatures({
    asset: "BTC",
    nowMs: now,
    staleAfterMs: 45_000,
    observations: [obs("BTC", 100, now - 60_000)],
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.spot, null);
  assert.equal(snapshot.change1mBps, null);
});

test("deriveBinanceFeatures computes compact window moves", () => {
  const now = 2_000_000;
  const snapshot = deriveBinanceFeatures({
    asset: "ETH",
    nowMs: now,
    staleAfterMs: 45_000,
    referencePrice: 100,
    observations: [
      obs("ETH", 100, now - 360_000),
      obs("ETH", 100.5, now - 60_000),
      obs("ETH", 101, now - 1_000),
    ],
  });
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.spot, 101);
  assert.ok(snapshot.change1mBps !== null);
  assert.ok(snapshot.change5mBps !== null);
  assert.ok(snapshot.gapBps !== null);
  const five = featuresForDuration(snapshot, "5m");
  assert.ok("ch1" in five);
  assert.ok("ch5" in five);
  assert.equal("ch15" in five, false);
});

test("sampler cache is fail-closed when empty", () => {
  resetBinanceSamplerForTests();
  assert.equal(getCachedSpotQuote("BTC"), null);
  const snap = getBinanceFeatureSnapshot("BTC");
  assert.equal(snap.stale, true);
});

test("sampler cache returns the latest fresh observation", () => {
  resetBinanceSamplerForTests();
  const now = Date.now();
  recordObservation({ asset: "BTC", price: 68000, observedAtMs: now - 5_000 }, now);
  const cached = getCachedSpotQuote("BTC", now);
  assert.equal(cached?.price, 68000);
});

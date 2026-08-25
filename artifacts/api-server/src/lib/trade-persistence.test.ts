import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getUtcDayBounds,
  isOpenTradeStatus,
  isStalePendingIntent,
  isTerminalTradeStatus,
  sumRealizedPnl,
} from "./trade-state.ts";
import { buildReentryIdempotencyKey } from "./execution.ts";

describe("open position persistence rules", () => {
  it("counts only genuinely open or pending statuses", () => {
    assert.equal(isOpenTradeStatus("pending"), true);
    assert.equal(isOpenTradeStatus("submitted"), true);
    assert.equal(isOpenTradeStatus("partially_filled"), true);
    assert.equal(isOpenTradeStatus("filled"), true);
  });

  it("excludes terminal and failed statuses", () => {
    for (const status of [
      "redeemed",
      "settled",
      "cancelled",
      "failed",
    ]) {
      assert.equal(isOpenTradeStatus(status), false, status);
    }
  });

  it("recognizes terminal trades as closed generations", () => {
    assert.equal(isTerminalTradeStatus("failed"), true);
    assert.equal(isTerminalTradeStatus("settled"), true);
    assert.equal(isTerminalTradeStatus("pending"), false);
    assert.equal(isTerminalTradeStatus("filled"), false);
  });

  it("keeps duplicate retries on the same re-entry key", () => {
    const base = "u1:market:strategy:1.0.0:YES";
    const first = buildReentryIdempotencyKey(base, "terminal-trade-id");
    const retry = buildReentryIdempotencyKey(base, "terminal-trade-id");

    assert.equal(first, retry);
    assert.notEqual(first, base);
  });

  it("uses a different key after a later terminal trade", () => {
    const base = "u1:market:strategy:1.0.0:YES";
    const first = buildReentryIdempotencyKey(base, "terminal-trade-1");
    const second = buildReentryIdempotencyKey(base, "terminal-trade-2");

    assert.notEqual(first, second);
  });
});

describe("stale pending intent cleanup rules", () => {
  const activeMarket = {
    marketId: "market-active",
    expiry: "2000",
    indexerStatus: "Trading",
    onchainStatus: 1,
    tradable: true,
    finalized: false,
  };

  it("expires a pending intent when its market is finalized", () => {
    assert.equal(
      isStalePendingIntent({
        status: "pending",
        transactionHash: null,
        filledContracts: null,
        market: { ...activeMarket, finalized: true },
        nowSec: 1500,
      }),
      true,
    );
  });

  it("expires a pending intent when its market has passed expiry", () => {
    assert.equal(
      isStalePendingIntent({
        status: "pending",
        transactionHash: null,
        filledContracts: null,
        market: activeMarket,
        nowSec: 2000,
      }),
      true,
    );
  });

  it("keeps a genuinely active pending intent open", () => {
    assert.equal(
      isStalePendingIntent({
        status: "pending",
        transactionHash: null,
        filledContracts: null,
        market: { ...activeMarket, expiry: "3000" },
        nowSec: 1500,
      }),
      false,
    );
  });

  it("never expires a pending intent after a transaction or fill exists", () => {
    const staleMarket = { ...activeMarket, finalized: true };
    assert.equal(
      isStalePendingIntent({
        status: "pending",
        transactionHash: "0xabc",
        filledContracts: null,
        market: staleMarket,
        nowSec: 1500,
      }),
      false,
    );
    assert.equal(
      isStalePendingIntent({
        status: "pending",
        transactionHash: null,
        filledContracts: 1,
        market: staleMarket,
        nowSec: 1500,
      }),
      false,
    );
  });
});

describe("realized PnL persistence helpers", () => {
  it("aggregates positive, negative, and null values", () => {
    assert.equal(
      sumRealizedPnl([
        { pnl_usdso: "12.5" },
        { pnl_usdso: -4 },
        { pnl_usdso: null },
        { pnl_usdso: 1.5 },
      ]),
      10,
    );
  });

  it("uses the UTC calendar day and excludes the next day", () => {
    const bounds = getUtcDayBounds(new Date("2026-08-23T23:59:59.999Z"));
    assert.equal(bounds.start, "2026-08-23T00:00:00.000Z");
    assert.equal(bounds.end, "2026-08-24T00:00:00.000Z");
  });
});
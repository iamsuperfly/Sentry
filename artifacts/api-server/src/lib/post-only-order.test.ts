import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BINARY_ORDER_TYPES, isPostOnlyOrderType, liveEntryOrderType } from "./post-only-order.ts";
import { evaluateProtocolGates } from "./live-execution.ts";
import { SHANNON_TUSDC } from "./live-execution.ts";
import type { TradeIntent } from "./execution.ts";

describe("POST_ONLY capability", () => {
  it("exists as an execution type without changing live TAKE/IOC", () => {
    assert.equal(BINARY_ORDER_TYPES.POST_ONLY, "POST_ONLY");
    assert.equal(isPostOnlyOrderType("POST_ONLY"), true);
    assert.equal(liveEntryOrderType(), "IOC");
  });

  it("keeps protocol gates on IOC for the current strategy", () => {
    const r = evaluateProtocolGates({
      intent: {
        idempotencyKey: "k",
        userId: "u",
        walletAddress: "0xuser",
        marketId: "0xmarket1",
        symbol: "BTC/YES",
        direction: "up",
        side: "buy",
        strategyName: "edge-taker-v1",
        strategyVersion: "1.0.0",
        stake: 2,
        contracts: 5,
        limitPrice: 0.4,
        poolAddress: "0xpool",
        status: "pending",
        decision: {} as TradeIntent["decision"],
        rejectReason: null,
      },
      market: {
        marketId: "0xmarket1",
        onchainStatus: 1,
        poolAddress: "0xpool",
        collateral: SHANNON_TUSDC,
        decimals: 6,
        tickSize: 0.01,
        lotSize: 0.1,
        minQuantity: 0.001,
        expirySec: 2_000_000_000,
      },
      tusdcBalance: 50,
      allowance: 50,
      nowSec: 1_700_000_000,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.order.orderType, "IOC");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BINARY_ORDER_TYPES,
  isPostOnlyOrderType,
  liveEntryOrderType,
  postOnlyExpireAtSec,
  postOnlyWouldCross,
  selectEntryExecution,
} from "./post-only-order.ts";
import { evaluateProtocolGates } from "./live-execution.ts";
import { SHANNON_TUSDC } from "./live-execution.ts";
import type { TradeIntent } from "./execution.ts";
import { evaluatePreflightBook } from "./preflight-book.ts";

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

describe("selectEntryExecution", () => {
  const book = {
    yesAsk: { price: 0.4, quantity: 10 },
    noAsk: { price: 0.61, quantity: 8 },
  };

  it("takes when the fresh book is executable", () => {
    const pre = evaluatePreflightBook({
      outcome: "YES",
      limitPrice: 0.4,
      contracts: 5,
      book,
    });
    assert.equal(selectEntryExecution(pre).mode, "TAKE");
  });

  it("rests POST_ONLY when the ask moved above the intended limit", () => {
    const pre = evaluatePreflightBook({
      outcome: "YES",
      limitPrice: 0.4,
      contracts: 5,
      book: { yesAsk: { price: 0.5, quantity: 10 }, noAsk: book.noAsk },
    });
    const selected = selectEntryExecution(pre);
    assert.equal(selected.mode, "POST_ONLY");
    if (selected.mode === "POST_ONLY") assert.equal(selected.code, "book_stale");
  });

  it("rests POST_ONLY when there is no usable ask", () => {
    const pre = evaluatePreflightBook({
      outcome: "YES",
      limitPrice: 0.4,
      contracts: 5,
      book: { yesAsk: null, noAsk: book.noAsk },
    });
    const selected = selectEntryExecution(pre);
    assert.equal(selected.mode, "POST_ONLY");
    if (selected.mode === "POST_ONLY") assert.equal(selected.code, "no_usable_ask");
  });

  it("aborts when size is short (would cross at the same price)", () => {
    const pre = evaluatePreflightBook({
      outcome: "YES",
      limitPrice: 0.4,
      contracts: 50,
      book,
    });
    const selected = selectEntryExecution(pre);
    assert.equal(selected.mode, "ABORT");
    if (selected.mode === "ABORT") assert.equal(selected.code, "insufficient_liquidity");
  });

  it("detects a crossing maker quote", () => {
    assert.equal(
      postOnlyWouldCross({
        outcome: "YES",
        limitPrice: 0.4,
        book,
      }),
      true,
    );
    assert.equal(
      postOnlyWouldCross({
        outcome: "YES",
        limitPrice: 0.4,
        book: { yesAsk: { price: 0.41, quantity: 10 }, noAsk: null },
      }),
      false,
    );
    assert.equal(
      postOnlyWouldCross({
        outcome: "YES",
        limitPrice: 0.4,
        book: { yesAsk: null, noAsk: null },
      }),
      false,
    );
  });

  it("compares integer ticks when decimals are provided", () => {
    assert.equal(
      postOnlyWouldCross({
        outcome: "YES",
        limitPrice: 0.4,
        book: { yesAsk: { price: 0.4000000001, quantity: 1 }, noAsk: null },
        decimals: 6,
      }),
      true,
    );
    assert.equal(
      postOnlyWouldCross({
        outcome: "YES",
        limitPrice: 0.4,
        book: { yesAsk: { price: 0.41, quantity: 1 }, noAsk: null },
        decimals: 6,
      }),
      false,
    );
  });

  it("expires POST_ONLY at market-15 not now+120", () => {
    const now = 1_700_000_000;
    const expiry = now + 900;
    assert.equal(postOnlyExpireAtSec(now, expiry), expiry - 15);
    assert.notEqual(postOnlyExpireAtSec(now, expiry), now + 120);
  });
});

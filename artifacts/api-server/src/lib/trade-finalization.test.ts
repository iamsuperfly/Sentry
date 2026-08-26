import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { settlementFieldsFromMarket } from "./trade-finalization.ts";
import type { MarketLifecycleView } from "./position-lifecycle.ts";

describe("settlementFieldsFromMarket", () => {
  const baseTrade = {
    direction: "up",
    stake: 10,
    filledContracts: 20,
    contracts: 20,
  };

  it("computes win when YES (0) wins and direction is up", () => {
    const market: MarketLifecycleView = {
      marketId: "m1",
      expiry: 1,
      onchainStatus: 4,
      isResolved: true,
      winningOutcome: 0,
      finalized: true,
    };
    const r = settlementFieldsFromMarket(baseTrade, market);
    assert.equal(r.outcome, "up");
    assert.equal(r.pnl, 10);
  });

  it("computes loss when NO (1) wins and direction is up", () => {
    const market: MarketLifecycleView = {
      marketId: "m1",
      expiry: 1,
      onchainStatus: 4,
      isResolved: true,
      winningOutcome: 1,
      finalized: true,
    };
    const r = settlementFieldsFromMarket(baseTrade, market);
    assert.equal(r.outcome, "down");
    assert.equal(r.pnl, -10);
  });

  it("computes void 0.5 redeem without inventing a winner", () => {
    const market: MarketLifecycleView = {
      marketId: "m1",
      expiry: 1,
      onchainStatus: 5,
      isVoided: true,
      finalized: true,
    };
    const r = settlementFieldsFromMarket(baseTrade, market);
    assert.equal(r.outcome, "void");
    assert.equal(r.pnl, 0);
  });

  it("does not invent PnL without market snapshot", () => {
    const r = settlementFieldsFromMarket(baseTrade, null);
    assert.equal(r.outcome, null);
    assert.equal(r.pnl, null);
  });

  it("does not invent PnL when resolved without winner field", () => {
    const market: MarketLifecycleView = {
      marketId: "m1",
      expiry: 1,
      onchainStatus: 4,
      finalized: true,
      isResolved: true,
      winningOutcome: null,
    };
    const r = settlementFieldsFromMarket(baseTrade, market);
    assert.equal(r.outcome, null);
    assert.equal(r.pnl, null);
  });
});

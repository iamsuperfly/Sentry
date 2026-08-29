import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planPnlBackfill } from "./pnl-backfill.ts";
import type { MarketLifecycleView } from "./position-lifecycle.ts";

const settledNull = {
  id: "t1",
  userId: "u1",
  status: "settled",
  direction: "up",
  stake: 30,
  filledContracts: 200,
  contracts: 200,
  outcome: null,
  pnl: null,
};

describe("planPnlBackfill", () => {
  it("known loser → -stake", () => {
    const market: MarketLifecycleView = {
      marketId: "m",
      expiry: 1,
      isResolved: true,
      finalized: true,
      onchainStatus: 4,
      winningOutcome: 1,
    };
    const r = planPnlBackfill(settledNull, market);
    assert.equal(r.action, "write");
    if (r.action === "write") {
      assert.equal(r.outcome, "down");
      assert.equal(r.pnl, -30);
    }
  });

  it("known winner → contracts - stake", () => {
    const market: MarketLifecycleView = {
      marketId: "m",
      expiry: 1,
      isResolved: true,
      finalized: true,
      onchainStatus: 4,
      winningOutcome: 0,
    };
    const r = planPnlBackfill(settledNull, market);
    assert.equal(r.action, "write");
    if (r.action === "write") {
      assert.equal(r.outcome, "up");
      assert.equal(r.pnl, 170);
    }
  });

  it("void → 0.5 * contracts - stake", () => {
    const market: MarketLifecycleView = {
      marketId: "m",
      expiry: 1,
      isVoided: true,
      finalized: true,
      onchainStatus: 5,
    };
    const r = planPnlBackfill(
      { ...settledNull, filledContracts: 40, contracts: 40 },
      market,
    );
    assert.equal(r.action, "write");
    if (r.action === "write") {
      assert.equal(r.outcome, "void");
      assert.equal(r.pnl, -10);
    }
  });

  it("unknown winner leaves PnL null", () => {
    const market: MarketLifecycleView = {
      marketId: "m",
      expiry: 1,
      isResolved: true,
      finalized: true,
      onchainStatus: 4,
      winningOutcome: null,
    };
    const r = planPnlBackfill(settledNull, market);
    assert.equal(r.action, "none");
  });

  it("backfills previously settled + null pnl when data arrives", () => {
    const r = planPnlBackfill(settledNull, {
      marketId: "m",
      expiry: 1,
      isResolved: true,
      finalized: true,
      onchainStatus: 4,
      winningOutcome: 1,
    });
    assert.equal(r.action, "write");
  });

  it("does not overwrite existing reconstructed PnL", () => {
    const r = planPnlBackfill(
      { ...settledNull, pnl: -30, outcome: "down" },
      {
        marketId: "m",
        expiry: 1,
        isResolved: true,
        finalized: true,
        onchainStatus: 4,
        winningOutcome: 0,
      },
    );
    assert.equal(r.action, "none");
  });
});

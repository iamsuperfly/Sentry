import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideClaim } from "./claim-decision.ts";

const resolvedUp = {
  isResolved: true,
  isVoided: false,
  finalized: true,
  onchainStatus: 4,
  winningOutcome: 0,
};

describe("decideClaim", () => {
  it("marks winning balance claimable with outcomeIdx 0", () => {
    const r = decideClaim({
      tradeStatus: "settled",
      resolution: resolvedUp,
      balances: { up: 39.8, down: 0 },
    });
    assert.equal(r.action, "redeem");
    if (r.action === "redeem") {
      assert.equal(r.outcomeIdx, 0);
      assert.equal(r.kind, "win");
    }
  });

  it("skips zero winning balance", () => {
    const r = decideClaim({
      tradeStatus: "settled",
      resolution: resolvedUp,
      balances: { up: 0, down: 0 },
    });
    assert.equal(r.action, "skip");
    if (r.action === "skip") assert.equal(r.code, "zero_balance");
  });

  it("skips unresolved markets", () => {
    const r = decideClaim({
      tradeStatus: "settled",
      resolution: {
        isResolved: false,
        isVoided: false,
        finalized: false,
        onchainStatus: 1,
        winningOutcome: null,
      },
      balances: { up: 10, down: 0 },
    });
    assert.equal(r.action, "skip");
    if (r.action === "skip") assert.equal(r.code, "unresolved");
  });

  it("skips already redeemed trades", () => {
    const r = decideClaim({
      tradeStatus: "redeemed",
      resolution: resolvedUp,
      balances: { up: 10, down: 0 },
    });
    assert.equal(r.action, "skip");
    if (r.action === "skip") assert.equal(r.code, "already_claimed");
  });

  it("skips losing-only balances", () => {
    const r = decideClaim({
      tradeStatus: "settled",
      resolution: resolvedUp,
      balances: { up: 0, down: 40 },
    });
    assert.equal(r.action, "skip");
    if (r.action === "skip") assert.equal(r.code, "losing_position");
  });

  it("void with UP balance uses outcomeIdx 0", () => {
    const r = decideClaim({
      tradeStatus: "settled",
      resolution: {
        isResolved: false,
        isVoided: true,
        finalized: true,
        onchainStatus: 5,
        winningOutcome: null,
      },
      balances: { up: 20, down: 0 },
    });
    assert.equal(r.action, "redeem");
    if (r.action === "redeem") {
      assert.equal(r.outcomeIdx, 0);
      assert.equal(r.kind, "void");
    }
  });
});

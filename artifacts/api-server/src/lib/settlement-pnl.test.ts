import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeBinarySettlementPnl,
  mapMarketResolution,
  ONCHAIN_STATUS,
} from "./settlement-pnl.ts";

describe("mapMarketResolution", () => {
  it("marks trading/locked as not ready", () => {
    assert.equal(
      mapMarketResolution({ onchainStatus: ONCHAIN_STATUS.TRADING }).kind,
      "not_ready",
    );
    assert.equal(
      mapMarketResolution({ onchainStatus: ONCHAIN_STATUS.LOCKED }).kind,
      "not_ready",
    );
  });

  it("maps voided status", () => {
    const r = mapMarketResolution({ onchainStatus: ONCHAIN_STATUS.VOIDED });
    assert.equal(r.kind, "voided");
  });

  it("maps resolved with explicit winner", () => {
    const r = mapMarketResolution({
      onchainStatus: ONCHAIN_STATUS.RESOLVED,
      winningOutcome: "YES",
    });
    assert.equal(r.kind, "resolved");
    if (r.kind === "resolved") assert.equal(r.winner, "up");
  });

  it("does not invent winner when resolved without evidence", () => {
    const r = mapMarketResolution({
      onchainStatus: ONCHAIN_STATUS.RESOLVED,
      finalized: true,
    });
    assert.equal(r.kind, "unknown_resolved");
  });
});

describe("computeBinarySettlementPnl", () => {
  it("win: payout = contracts, pnl = contracts - stake", () => {
    const r = computeBinarySettlementPnl({
      direction: "up",
      stake: 10,
      filledContracts: 19.4,
      resolution: { kind: "resolved", winner: "up" },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.outcome, "up");
      assert.equal(r.payout, 19.4);
      assert.ok(Math.abs(r.pnl - 9.4) < 1e-9);
      assert.equal(r.won, true);
    }
  });

  it("loss: payout 0, pnl = -stake even without size", () => {
    const r = computeBinarySettlementPnl({
      direction: "up",
      stake: 10,
      filledContracts: null,
      resolution: { kind: "resolved", winner: "down" },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.payout, 0);
      assert.equal(r.pnl, -10);
      assert.equal(r.won, false);
    }
  });

  it("void: 0.5 redeem per contract", () => {
    const r = computeBinarySettlementPnl({
      direction: "down",
      stake: 10,
      filledContracts: 20,
      resolution: { kind: "voided" },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.outcome, "void");
      assert.equal(r.payout, 10);
      assert.equal(r.pnl, 0);
    }
  });

  it("refuses win without contract size", () => {
    const r = computeBinarySettlementPnl({
      direction: "up",
      stake: 10,
      filledContracts: null,
      resolution: { kind: "resolved", winner: "up" },
    });
    assert.equal(r.ok, false);
  });

  it("refuses inventing outcome when resolution unknown", () => {
    const r = computeBinarySettlementPnl({
      direction: "up",
      stake: 10,
      filledContracts: 10,
      resolution: {
        kind: "unknown_resolved",
        reason: "no winner field",
      },
    });
    assert.equal(r.ok, false);
  });
});

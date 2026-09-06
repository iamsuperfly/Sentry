import assert from "node:assert/strict";
import test from "node:test";
import { realizedStakeBasis, splitEarlyExitInventory } from "./cost-basis.ts";
import { computeBinarySettlementPnl } from "./settlement-pnl.ts";
import {
  classifySettledResult,
  summarizePerformance,
} from "./performance-summary.ts";

test("full fill settlement win uses requested stake", () => {
  const r = computeBinarySettlementPnl({
    direction: "up",
    stake: 20,
    filledContracts: 40,
    contracts: 40,
    limitPrice: 0.5,
    resolution: { kind: "resolved", winner: "up" },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.stakeUsed, 20);
    assert.equal(r.payout, 40);
    assert.equal(r.pnl, 20);
  }
});

test("partial fill cost basis then later settlement of remainder path", () => {
  const basis = realizedStakeBasis({
    requestedStake: 28,
    filledContracts: 10,
    plannedContracts: 40,
    limitPrice: 0.7,
  });
  assert.equal(basis, 7);
  const loss = computeBinarySettlementPnl({
    direction: "up",
    stake: 28,
    filledContracts: 10,
    contracts: 40,
    limitPrice: 0.7,
    resolution: { kind: "resolved", winner: "down" },
  });
  assert.equal(loss.ok, true);
  if (loss.ok) assert.equal(loss.pnl, -7);
});

test("partial early exit books sold slice once; remainder settles separately", () => {
  const split = splitEarlyExitInventory({
    positionStake: 28,
    positionContracts: 40,
    soldContracts: 15,
    proceeds: 6,
  });
  assert.equal(split.soldContracts, 15);
  assert.equal(split.soldStake, 10.5);
  assert.equal(split.pnl, -4.5);
  assert.equal(split.remainingContracts, 25);
  assert.equal(split.remainingStake, 17.5);
  assert.equal(split.closedFully, false);

  const soldRow = {
    status: "cancelled",
    pnl: split.pnl,
    stake: split.soldStake,
    outcome: null,
    settledAt: "2026-09-06T12:00:00.000Z",
  };
  const remainderSettle = computeBinarySettlementPnl({
    direction: "up",
    stake: split.remainingStake,
    filledContracts: split.remainingContracts,
    contracts: split.remainingContracts,
    limitPrice: 0.7,
    resolution: { kind: "resolved", winner: "up" },
  });
  assert.equal(remainderSettle.ok, true);
  if (!remainderSettle.ok) return;
  const remainderRow = {
    status: "settled",
    pnl: remainderSettle.pnl,
    stake: split.remainingStake,
    outcome: "up",
    settledAt: "2026-09-06T13:00:00.000Z",
  };

  assert.equal(classifySettledResult(soldRow), "loss");
  assert.equal(classifySettledResult(remainderRow), "win");

  const summary = summarizePerformance(
    [soldRow, remainderRow],
    new Date("2026-09-06T18:00:00.000Z"),
  );
  assert.equal(summary.losses, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.settledTrades, 2);
  assert.equal(summary.dailyPnl, Math.round((split.pnl + remainderSettle.pnl) * 1e6) / 1e6);
  assert.equal(summary.allTimePnl, summary.dailyPnl);

  const soldAgain = splitEarlyExitInventory({
    positionStake: split.remainingStake,
    positionContracts: split.remainingContracts,
    soldContracts: split.remainingContracts,
    proceeds: 5,
  });
  assert.equal(soldAgain.closedFully, true);
  assert.equal(soldAgain.remainingContracts, 0);
});

test("failed and open rows never enter realized totals", () => {
  const summary = summarizePerformance(
    [
      { status: "failed", pnl: -28, stake: 28, outcome: null, settledAt: "2026-09-06T12:00:00.000Z" },
      { status: "filled", pnl: 12, stake: 20, outcome: "up", settledAt: null },
    ],
    new Date("2026-09-06T18:00:00.000Z"),
  );
  assert.equal(summary.settledTrades, 0);
  assert.equal(summary.allTimePnl, 0);
  assert.equal(summary.dailyPnl, 0);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizePerformance, type PerformanceTrade } from "./performance-summary.ts";
import { evaluateDayHalt } from "./risk-supervisor.ts";
import { isInstantInLocalDay } from "./user-timezone.ts";

function trade(
  userTag: string,
  settledAt: string,
  pnl: number,
  status = "settled",
): PerformanceTrade {
  void userTag;
  return {
    status,
    pnl,
    stake: 10,
    outcome: pnl >= 0 ? "up" : "down",
    settledAt,
  };
}

describe("UTC-day PnL isolation", () => {
  it("resets daily stats at 00:00 UTC without touching all-time", () => {
    const rows = [
      trade("a", "2026-09-09T23:59:00.000Z", 5),
      trade("a", "2026-09-10T00:01:00.000Z", -2),
    ];
    const beforeMidnight = summarizePerformance(rows, new Date("2026-09-09T23:59:30.000Z"));
    const afterMidnight = summarizePerformance(rows, new Date("2026-09-10T00:00:00.000Z"));

    assert.equal(beforeMidnight.dailyPnl, 5);
    assert.equal(beforeMidnight.dailyWins, 1);
    assert.equal(beforeMidnight.dailyLosses, 0);
    assert.equal(afterMidnight.dailyPnl, -2);
    assert.equal(afterMidnight.dailyWins, 0);
    assert.equal(afterMidnight.dailyLosses, 1);
    assert.equal(beforeMidnight.allTimePnl, afterMidnight.allTimePnl);
    assert.equal(afterMidnight.allTimePnl, 3);
  });

  it("keeps User A and User B daily PnL independent", () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    const alice = summarizePerformance(
      [trade("alice", "2026-09-10T01:00:00.000Z", 12), trade("alice", "2026-09-09T01:00:00.000Z", -4)],
      now,
    );
    const bob = summarizePerformance(
      [trade("bob", "2026-09-10T01:00:00.000Z", -8)],
      now,
    );
    assert.equal(alice.dailyPnl, 12);
    assert.equal(bob.dailyPnl, -8);
    assert.equal(alice.allTimePnl, 8);
    assert.equal(bob.allTimePnl, -8);
  });

  it("does not double-count settled then redeemed rows", () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    const settled = summarizePerformance(
      [trade("a", "2026-09-10T03:00:00.000Z", 4.5, "settled")],
      now,
    );
    const redeemed = summarizePerformance(
      [trade("a", "2026-09-10T03:00:00.000Z", 4.5, "redeemed")],
      now,
    );
    assert.equal(settled.dailyPnl, redeemed.dailyPnl);
    assert.equal(settled.allTimePnl, redeemed.allTimePnl);
    assert.equal(settled.unclaimedPositions, 1);
    assert.equal(redeemed.unclaimedPositions, 0);
  });

  it("lifts daily halt after UTC midnight for a user without affecting another", () => {
    const haltA = evaluateDayHalt({
      tradingEnabled: true,
      realizedPnlToday: -70,
      maxDailyLoss: 50,
      systemMaxDailyLoss: 300,
      dailyProfitTarget: null,
    });
    const nextDayA = evaluateDayHalt({
      tradingEnabled: true,
      realizedPnlToday: 0,
      maxDailyLoss: 50,
      systemMaxDailyLoss: 300,
      dailyProfitTarget: null,
    });
    const userB = evaluateDayHalt({
      tradingEnabled: true,
      realizedPnlToday: -10,
      maxDailyLoss: 50,
      systemMaxDailyLoss: 300,
      dailyProfitTarget: null,
    });
    assert.equal(haltA.halt, true);
    assert.equal(nextDayA.halt, false);
    assert.equal(userB.halt, false);
  });

  it("treats 23:30 UTC as the previous calendar day", () => {
    assert.equal(
      isInstantInLocalDay(
        "2026-09-09T23:30:00.000Z",
        new Date("2026-09-10T00:05:00.000Z"),
        "Africa/Lagos",
      ),
      false,
    );
  });
});

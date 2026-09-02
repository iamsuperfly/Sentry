import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySettledResult,
  formatPerformanceMessage,
  summarizePerformance,
  unclaimedPayout,
} from "./performance-summary.ts";

test("open and failed trades are ignored", () => {
  assert.equal(
    classifySettledResult({ status: "filled", pnl: 4, outcome: "up" }),
    "ignored",
  );
  assert.equal(
    classifySettledResult({ status: "failed", pnl: -30, outcome: null }),
    "ignored",
  );
  assert.equal(
    classifySettledResult({ status: "cancelled", pnl: null, outcome: null }),
    "ignored",
  );
});

test("early-exit cancelled with realized pnl counts", () => {
  assert.equal(
    classifySettledResult({ status: "cancelled", pnl: -16.2, outcome: null }),
    "loss",
  );
});

test("unknown reconstructed PnL stays excluded", () => {
  assert.equal(
    classifySettledResult({ status: "settled", pnl: null, outcome: null }),
    "unknown",
  );
});

test("win/loss/void classification", () => {
  assert.equal(
    classifySettledResult({ status: "settled", pnl: 4.48, outcome: "up" }),
    "win",
  );
  assert.equal(
    classifySettledResult({ status: "redeemed", pnl: -30, outcome: "down" }),
    "loss",
  );
  assert.equal(
    classifySettledResult({ status: "settled", pnl: -5, outcome: "void" }),
    "void",
  );
});

test("unclaimed payout uses stake + pnl only for settled winners", () => {
  assert.equal(
    unclaimedPayout({ status: "settled", pnl: 4.48, stake: 30, outcome: "up" }),
    34.48,
  );
  assert.equal(
    unclaimedPayout({ status: "redeemed", pnl: 4.48, stake: 30, outcome: "up" }),
    null,
  );
  assert.equal(
    unclaimedPayout({ status: "settled", pnl: -30, stake: 30, outcome: "down" }),
    null,
  );
});

test("summary aggregates all-time, daily, and unclaimed without double count", () => {
  const now = new Date("2026-08-29T18:00:00.000Z");
  const summary = summarizePerformance(
    [
      {
        status: "settled",
        pnl: 4.48,
        stake: 30,
        outcome: "up",
        settledAt: "2026-08-29T12:00:00.000Z",
      },
      {
        status: "redeemed",
        pnl: 12.4,
        stake: 30,
        outcome: "up",
        settledAt: "2026-08-29T13:00:00.000Z",
      },
      {
        status: "settled",
        pnl: -30,
        stake: 30,
        outcome: "down",
        settledAt: "2026-08-28T12:00:00.000Z",
      },
      {
        status: "settled",
        pnl: null,
        stake: 30,
        outcome: null,
        settledAt: "2026-08-29T14:00:00.000Z",
      },
      {
        status: "failed",
        pnl: null,
        stake: 30,
        outcome: null,
        settledAt: null,
      },
      {
        status: "filled",
        pnl: null,
        stake: 30,
        outcome: null,
        settledAt: null,
      },
    ],
    now,
    "Africa/Lagos",
  );

  assert.equal(summary.allTimePnl, -13.12);
  assert.equal(summary.dailyPnl, 16.88);
  assert.equal(summary.wins, 2);
  assert.equal(summary.losses, 1);
  assert.equal(summary.settledTrades, 3);
  assert.equal(summary.excludedUnknownPnl, 1);
  assert.equal(summary.unclaimedPositions, 1);
  assert.equal(summary.unclaimedValue, 34.48);
});

test("redeemed winner leaves realized PnL and drops unclaimed", () => {
  const before = summarizePerformance([
    {
      status: "settled",
      pnl: 4.48,
      stake: 30,
      outcome: "up",
      settledAt: "2026-08-29T12:00:00.000Z",
    },
  ]);
  const after = summarizePerformance([
    {
      status: "redeemed",
      pnl: 4.48,
      stake: 30,
      outcome: "up",
      settledAt: "2026-08-29T12:00:00.000Z",
    },
  ]);
  assert.equal(before.allTimePnl, after.allTimePnl);
  assert.equal(before.unclaimedPositions, 1);
  assert.equal(after.unclaimedPositions, 0);
});

test("performance message is compact", () => {
  const text = formatPerformanceMessage({
    allTimePnl: 47.85,
    dailyPnl: 12.4,
    reconstructedCount: 18,
    excludedUnknownPnl: 2,
    settledTrades: 18,
    wins: 11,
    losses: 7,
    voids: 0,
    unclaimedPositions: 2,
    unclaimedValue: 34.48,
  });
  assert.match(text, /Today/);
  assert.doesNotMatch(text, /Today \(UTC\)/);
  assert.match(text, /\+12\.4 tUSDC/);
  assert.match(text, /All time/);
  assert.match(text, /\+47\.85 tUSDC/);
  assert.match(text, /Unclaimed/);
  assert.match(text, /Positions: 2/);
});

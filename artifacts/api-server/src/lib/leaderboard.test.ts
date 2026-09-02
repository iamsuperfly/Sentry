import assert from "node:assert/strict";
import test from "node:test";
import { aggregateLeaderboard, displayIdentity } from "./leaderboard.ts";

const now = new Date("2026-08-31T18:00:00.000Z");

test("cancelled early-exit pnl ranks", () => {
  const ranked = aggregateLeaderboard(
    [
      {
        userId: "a",
        username: "alice",
        firstName: "A",
        status: "cancelled",
        pnl: -12,
        outcome: null,
        settledAt: "2026-08-31T12:00:00.000Z",
      },
    ],
    { now, timeZone: "UTC", daily: false },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.pnl, -12);
});

test("failed trades do not rank", () => {
  const ranked = aggregateLeaderboard(
    [
      {
        userId: "a",
        username: "alice",
        firstName: "A",
        status: "failed",
        pnl: 99,
        outcome: "up",
        settledAt: "2026-08-31T12:00:00.000Z",
      },
      {
        userId: "b",
        username: "bob",
        firstName: "B",
        status: "settled",
        pnl: 10,
        outcome: "up",
        settledAt: "2026-08-31T12:00:00.000Z",
      },
    ],
    { now, timeZone: "UTC", daily: false },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.displayName, "@bob");
});

test("tie uses later settled_at", () => {
  const ranked = aggregateLeaderboard(
    [
      {
        userId: "a",
        username: "alice",
        firstName: "A",
        status: "settled",
        pnl: 10,
        outcome: "up",
        settledAt: "2026-08-31T10:00:00.000Z",
      },
      {
        userId: "b",
        username: "bob",
        firstName: "B",
        status: "settled",
        pnl: 10,
        outcome: "up",
        settledAt: "2026-08-31T12:00:00.000Z",
      },
    ],
    { now, timeZone: "UTC", daily: false },
  );
  assert.equal(ranked[0]?.userId, "b");
  assert.equal(ranked[1]?.userId, "a");
});

test("daily board uses UTC day", () => {
  const ranked = aggregateLeaderboard(
    [
      {
        userId: "a",
        username: "alice",
        firstName: "A",
        status: "settled",
        pnl: 5,
        outcome: "up",
        settledAt: "2026-08-30T23:30:00.000Z",
      },
    ],
    {
      now: new Date("2026-08-31T10:00:00.000Z"),
      timeZone: "UTC",
      daily: true,
    },
  );
  assert.equal(ranked.length, 0);
});

test("display falls back to first name", () => {
  assert.equal(displayIdentity({ username: null, firstName: "Ada" }), "Ada");
});

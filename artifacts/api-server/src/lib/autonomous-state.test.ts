import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldRunAutonomousTick,
  type AutonomousRow,
} from "./autonomous-state.ts";

function row(overrides: Partial<AutonomousRow> = {}): AutonomousRow {
  return {
    userId: "u1",
    telegramUserId: 1,
    chatId: 1,
    timezone: "Africa/Lagos",
    tradingEnabled: true,
    autonomousEnabled: true,
    autonomousPausedAt: null,
    lastAutonomousScanAt: null,
    lastAutonomousLocalDate: "2026-08-31",
    defaultStake: 30,
    executionMode: "testnet",
    ...overrides,
  };
}

test("runs when enabled and not paused", () => {
  const decision = shouldRunAutonomousTick(
    row(),
    new Date("2026-08-31T18:00:00.000Z"),
  );
  assert.equal(decision.run, true);
});

test("pauses when Lagos date rolls past last scan date", () => {
  const decision = shouldRunAutonomousTick(
    row({ lastAutonomousLocalDate: "2026-08-31" }),
    new Date("2026-08-31T23:05:00.000Z"),
  );
  assert.equal(decision.pauseForNewDay, true);
  assert.equal(decision.run, false);
});

test("skips paused users", () => {
  const decision = shouldRunAutonomousTick(
    row({ autonomousPausedAt: "2026-08-31T23:00:00.000Z" }),
    new Date("2026-08-31T23:10:00.000Z"),
  );
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "paused");
});

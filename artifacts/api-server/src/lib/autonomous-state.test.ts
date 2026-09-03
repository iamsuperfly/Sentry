import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../config.ts";
import { buildAutonomousTradeCycleInput } from "./autonomous-input.ts";
import {
  shouldRunAutonomousTick,
  type AutonomousRow,
} from "./autonomous-state.ts";

function row(overrides: Partial<AutonomousRow> = {}): AutonomousRow {
  return {
    userId: "u1",
    telegramUserId: 1,
    chatId: 1,
    timezone: "UTC",
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

test("pauses when UTC date rolls past last scan date", () => {
  const decision = shouldRunAutonomousTick(
    row({ lastAutonomousLocalDate: "2026-08-31" }),
    new Date("2026-09-01T00:05:00.000Z"),
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

test("builds the autonomous trade input with exclusions and identity", () => {
  const excludedMarketIds = ["market-1"];
  const input = buildAutonomousTradeCycleInput(
    {} as AppConfig,
    row({
      telegramUserId: 12345,
      chatId: 67890,
      defaultStake: 3,
    }),
    excludedMarketIds,
  );

  assert.deepEqual(input.identity, {
    id: 12345,
    username: undefined,
    first_name: "trader",
  });
  assert.equal(input.liveExecutionRequested, true);
  assert.equal(input.stake, 3);
  assert.strictEqual(input.excludeMarketIds, excludedMarketIds);
});

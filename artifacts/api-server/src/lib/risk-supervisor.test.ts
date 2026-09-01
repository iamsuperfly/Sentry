import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateDayHalt,
  formatAutonomousDailyReport,
  formatDayHaltMessage,
  summarizeDayActivity,
} from "./risk-supervisor.ts";

describe("evaluateDayHalt", () => {
  const base = {
    tradingEnabled: true,
    realizedPnlToday: 0,
    maxDailyLoss: 70,
    dailyProfitTarget: null as number | null,
    systemMaxDailyLoss: 300,
  };

  it("allows trading when under limits", () => {
    assert.deepEqual(evaluateDayHalt(base), { halt: false });
  });

  it("halts when trading is disabled without scanning", () => {
    const result = evaluateDayHalt({ ...base, tradingEnabled: false });
    assert.equal(result.halt, true);
    if (result.halt) assert.equal(result.code, "trading_disabled");
  });

  it("halts on user daily loss", () => {
    const result = evaluateDayHalt({ ...base, realizedPnlToday: -70 });
    assert.equal(result.halt, true);
    if (result.halt) assert.equal(result.code, "user_daily_loss_stop");
  });

  it("halts on system daily loss first", () => {
    const result = evaluateDayHalt({
      ...base,
      maxDailyLoss: 300,
      realizedPnlToday: -300,
    });
    assert.equal(result.halt, true);
    if (result.halt) assert.equal(result.code, "system_daily_loss_stop");
  });

  it("halts on profit target", () => {
    const result = evaluateDayHalt({
      ...base,
      dailyProfitTarget: 40,
      realizedPnlToday: 40,
    });
    assert.equal(result.halt, true);
    if (result.halt) assert.equal(result.code, "daily_profit_target_reached");
  });
});

describe("messages", () => {
  it("includes today's PnL on loss halt", () => {
    const text = formatDayHaltMessage({
      code: "user_daily_loss_stop",
      realizedPnlToday: -42.5,
      maxDailyLoss: 70,
    });
    assert.match(text, /Daily loss limit reached/);
    assert.match(text, /-42\.5/);
    assert.match(text, /UTC/);
    assert.doesNotMatch(text, /Groq/);
  });

  it("formats the UTC daily report", () => {
    const text = formatAutonomousDailyReport({
      activity: { attempted: 8, filled: 3, failed: 4, cancelled: 1 },
      dailyPnl: 12.4,
      wins: 2,
      losses: 1,
      unclaimedPositions: 2,
      unclaimedValue: 48.5,
    });
    assert.match(text, /Daily report/);
    assert.match(text, /Trades attempted: 8/);
    assert.match(text, /Filled: 3/);
    assert.match(text, /Failed: 4/);
    assert.match(text, /\+12\.4/);
    assert.match(text, /Unclaimed positions: 2/);
  });

  it("counts day activity from trade statuses", () => {
    const summary = summarizeDayActivity([
      { status: "filled" },
      { status: "settled" },
      { status: "failed" },
      { status: "cancelled" },
      { status: "pending" },
    ]);
    assert.equal(summary.attempted, 5);
    assert.equal(summary.filled, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.cancelled, 1);
  });
});

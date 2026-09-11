import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldMarkAutonomousScan,
  shouldNotifyAutonomousScan,
  shouldRunMaintenancePhases,
  wsTradingMinIntervalMs,
} from "./autonomous-policy.ts";

describe("autonomous tick policy", () => {
  it("runs claims and early-exit only on full ticks", () => {
    assert.equal(shouldRunMaintenancePhases("full"), true);
    assert.equal(shouldRunMaintenancePhases("trading"), false);
    assert.equal(shouldMarkAutonomousScan("full"), true);
    assert.equal(shouldMarkAutonomousScan("trading"), false);
  });

  it("wakes immediately on new windows and rate-limits book_change", () => {
    assert.equal(wsTradingMinIntervalMs("market_live", 8_000), 0);
    assert.equal(wsTradingMinIntervalMs("new_window", 8_000), 0);
    assert.equal(wsTradingMinIntervalMs("book_change", 8_000), 8_000);
  });

  it("does not telegram-notify empty or book-miss scans", () => {
    assert.equal(
      shouldNotifyAutonomousScan({ ok: false, code: "no_enter_decision", placedCount: 0 }),
      false,
    );
    assert.equal(
      shouldNotifyAutonomousScan({
        ok: false,
        code: "book_stale",
        reason: "Live YES ask 0.61 is above intended limit 0.50",
        placedCount: 0,
      }),
      false,
    );
    assert.equal(
      shouldNotifyAutonomousScan({
        ok: false,
        code: "submission_failed",
        reason: "PostOnlyWouldCross()",
        placedCount: 0,
      }),
      false,
    );
    assert.equal(
      shouldNotifyAutonomousScan({ ok: true, placedCount: 0 }),
      false,
    );
  });

  it("notifies on fills, resting makers, and day halts", () => {
    assert.equal(shouldNotifyAutonomousScan({ ok: true, placedCount: 1 }), true);
    assert.equal(
      shouldNotifyAutonomousScan({ ok: false, code: "user_daily_loss_stop", placedCount: 0 }),
      true,
    );
    assert.equal(
      shouldNotifyAutonomousScan({ ok: false, code: "user_max_open_positions", placedCount: 0 }),
      true,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getUtcDayBounds,
  isOpenTradeStatus,
  sumRealizedPnl,
} from "./trade-state.ts";

describe("open position persistence rules", () => {
  it("counts only genuinely open or pending statuses", () => {
    assert.equal(isOpenTradeStatus("pending"), true);
    assert.equal(isOpenTradeStatus("submitted"), true);
    assert.equal(isOpenTradeStatus("partially_filled"), true);
    assert.equal(isOpenTradeStatus("filled"), true);
  });

  it("excludes terminal and failed statuses", () => {
    for (const status of [
      "redeemed",
      "settled",
      "cancelled",
      "failed",
    ]) {
      assert.equal(isOpenTradeStatus(status), false, status);
    }
  });
});

describe("realized PnL persistence helpers", () => {
  it("aggregates positive, negative, and null values", () => {
    assert.equal(
      sumRealizedPnl([
        { pnl_usdso: "12.5" },
        { pnl_usdso: -4 },
        { pnl_usdso: null },
        { pnl_usdso: 1.5 },
      ]),
      10,
    );
  });

  it("uses the UTC calendar day and excludes the next day", () => {
    const bounds = getUtcDayBounds(new Date("2026-08-23T23:59:59.999Z"));
    assert.equal(bounds.start, "2026-08-23T00:00:00.000Z");
    assert.equal(bounds.end, "2026-08-24T00:00:00.000Z");
  });
});
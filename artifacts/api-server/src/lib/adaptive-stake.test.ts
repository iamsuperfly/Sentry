import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confidenceStakeFraction,
  executableAskNotional,
  remainingDailyLossBudget,
  sizeAdaptiveScan,
  sizeAdaptiveStake,
} from "./adaptive-stake.ts";

describe("confidence bands", () => {
  it("skips below 0.55", () => {
    assert.equal(confidenceStakeFraction(0.549), null);
    assert.equal(confidenceStakeFraction(0.54), null);
  });

  it("maps the documented fractions", () => {
    assert.equal(confidenceStakeFraction(0.55), 0.25);
    assert.equal(confidenceStakeFraction(0.64), 0.25);
    assert.equal(confidenceStakeFraction(0.65), 0.4);
    assert.equal(confidenceStakeFraction(0.74), 0.4);
    assert.equal(confidenceStakeFraction(0.75), 0.6);
    assert.equal(confidenceStakeFraction(0.84), 0.6);
    assert.equal(confidenceStakeFraction(0.85), 0.8);
    assert.equal(confidenceStakeFraction(0.99), 0.8);
  });
});

describe("sizeAdaptiveStake", () => {
  const base = {
    maxTradeStake: 40,
    systemMinStake: 1,
    systemMaxStake: 200,
    remainingBudget: 300,
    askNotional: 1000 as number | null,
  };

  it("uses 25% of maxTradeStake at 0.55", () => {
    const r = sizeAdaptiveStake({ ...base, confidence: 0.55 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.stake, 10);
  });

  it("uses 80% at high confidence", () => {
    const r = sizeAdaptiveStake({ ...base, confidence: 0.9 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.stake, 32);
  });

  it("caps to book notional", () => {
    const r = sizeAdaptiveStake({
      ...base,
      confidence: 0.9,
      askNotional: 5,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.stake, 5);
  });

  it("caps to remaining daily budget", () => {
    const r = sizeAdaptiveStake({
      ...base,
      confidence: 0.9,
      remainingBudget: 3,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.stake, 3);
  });

  it("rejects when sized stake is below system min", () => {
    const r = sizeAdaptiveStake({
      ...base,
      maxTradeStake: 2,
      confidence: 0.55,
      systemMinStake: 1,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "stake_below_system_min");
  });

  it("rejects exhausted daily budget", () => {
    const r = sizeAdaptiveStake({
      ...base,
      confidence: 0.8,
      remainingBudget: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "daily_budget_exhausted");
  });

  it("never exceeds maxTradeStake", () => {
    const r = sizeAdaptiveStake({
      ...base,
      maxTradeStake: 10,
      systemMaxStake: 200,
      confidence: 0.99,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.stake, 8);
      assert.ok(r.stake <= 10);
    }
  });
});

describe("scan budget", () => {
  it("reduces remaining budget across candidates", () => {
    const sized = sizeAdaptiveScan({
      candidates: [
        { marketId: "a", confidence: 0.9, askNotional: 100 },
        { marketId: "b", confidence: 0.9, askNotional: 100 },
        { marketId: "c", confidence: 0.9, askNotional: 100 },
      ],
      maxTradeStake: 20,
      systemMinStake: 1,
      systemMaxStake: 200,
      remainingBudget: 20,
    });
    assert.equal(sized[0]?.ok, true);
    assert.equal(sized[1]?.ok, true);
    if (sized[0]?.ok && sized[1]?.ok) {
      assert.equal(sized[0].stake, 16);
      assert.equal(sized[1].stake, 4);
    }
    assert.equal(sized[2]?.ok, false);
  });
});

describe("helpers", () => {
  it("computes remaining loss budget without inflating on wins", () => {
    assert.equal(
      remainingDailyLossBudget({
        realizedPnlToday: -20,
        userMaxDailyLoss: 70,
        systemMaxDailyLoss: 300,
      }),
      50,
    );
    assert.equal(
      remainingDailyLossBudget({
        realizedPnlToday: 15,
        userMaxDailyLoss: 70,
        systemMaxDailyLoss: 300,
      }),
      70,
    );
  });

  it("converts raw ask quantity into notional", () => {
    const n = executableAskNotional({
      askPrice: 0.5,
      askQuantityRaw: "2000000",
      decimals: 6,
    });
    assert.equal(n, 1);
  });
});

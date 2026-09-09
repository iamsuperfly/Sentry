import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entryPriceEdge,
  remainingDailyLossBudget,
  sizeAdaptiveStakeFromEntry,
  stakeFractionFromStrength,
  stakeStrengthFromEdge,
} from "./adaptive-stake.ts";

describe("entry-price adaptive stake", () => {
  it("computes edge as 0.50 minus the bought outcome price for YES and NO", () => {
    assert.equal(entryPriceEdge(0.4), 0.1);
    assert.equal(entryPriceEdge(0.42), 0.08);
    assert.equal(entryPriceEdge(0.15), 0.35);
    assert.equal(entryPriceEdge(0), null);
    assert.equal(entryPriceEdge(1), null);
    assert.equal(entryPriceEdge(-0.1), null);
  });

  it("maps edge to strength 0.50 + edge (not confidence, not the price)", () => {
    assert.equal(stakeStrengthFromEdge(0.08), 0.58);
    assert.equal(stakeStrengthFromEdge(0.0), 0.5);
    assert.equal(stakeStrengthFromEdge(0.35), 0.85);
  });

  it("uses the published strength bands", () => {
    assert.equal(stakeFractionFromStrength(0.54), 0.25);
    assert.equal(stakeFractionFromStrength(0.55), 0.3);
    assert.equal(stakeFractionFromStrength(0.64), 0.3);
    assert.equal(stakeFractionFromStrength(0.65), 0.4);
    assert.equal(stakeFractionFromStrength(0.74), 0.4);
    assert.equal(stakeFractionFromStrength(0.75), 0.6);
    assert.equal(stakeFractionFromStrength(0.84), 0.6);
    assert.equal(stakeFractionFromStrength(0.85), 0.8);
  });

  it("sizes 50 maxTradeStake into 12.5 / 15 / 20 / 30 / 40", () => {
    const base = {
      maxTradeStake: 50,
      systemMinStake: 1,
      systemMaxStake: 200,
      remainingBudget: 300,
    };

    const nearFair = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.46 });
    assert.equal(nearFair.ok, true);
    if (nearFair.ok) {
      assert.equal(nearFair.edge, 0.04);
      assert.equal(nearFair.strength, 0.54);
      assert.equal(nearFair.fraction, 0.25);
      assert.equal(nearFair.stake, 12.5);
    }

    const band30 = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.42 });
    assert.equal(band30.ok, true);
    if (band30.ok) {
      assert.equal(band30.fraction, 0.3);
      assert.equal(band30.stake, 15);
    }

    const band40 = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.3 });
    assert.equal(band40.ok, true);
    if (band40.ok) {
      assert.equal(band40.fraction, 0.4);
      assert.equal(band40.stake, 20);
    }

    const band60 = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.2 });
    assert.equal(band60.ok, true);
    if (band60.ok) {
      assert.equal(band60.edge, 0.3);
      assert.equal(band60.strength, 0.8);
      assert.equal(band60.fraction, 0.6);
      assert.equal(band60.stake, 30);
    }

    const band80 = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.15 });
    assert.equal(band80.ok, true);
    if (band80.ok) {
      assert.equal(band80.fraction, 0.8);
      assert.equal(band80.stake, 40);
    }
  });

  it("clips by remaining budget and does not skip risk floors", () => {
    const clipped = sizeAdaptiveStakeFromEntry({
      entryPrice: 0.15,
      maxTradeStake: 50,
      systemMinStake: 1,
      systemMaxStake: 200,
      remainingBudget: 18,
    });
    assert.equal(clipped.ok, true);
    if (clipped.ok) assert.equal(clipped.stake, 18);

    const tooSmall = sizeAdaptiveStakeFromEntry({
      entryPrice: 0.42,
      maxTradeStake: 50,
      systemMinStake: 10,
      systemMaxStake: 200,
      remainingBudget: 5,
    });
    assert.equal(tooSmall.ok, false);
  });

  it("clips by collateral and ask notional", () => {
    const collat = sizeAdaptiveStakeFromEntry({
      entryPrice: 0.15,
      maxTradeStake: 50,
      systemMinStake: 1,
      systemMaxStake: 200,
      remainingBudget: 300,
      collateralBalance: 22,
    });
    assert.equal(collat.ok, true);
    if (collat.ok) assert.equal(collat.stake, 22);

    const liq = sizeAdaptiveStakeFromEntry({
      entryPrice: 0.15,
      maxTradeStake: 50,
      systemMinStake: 1,
      systemMaxStake: 200,
      remainingBudget: 300,
      askNotional: 11.11,
    });
    assert.equal(liq.ok, true);
    if (liq.ok) assert.equal(liq.stake, 11.11);
  });

  it("floors stake to two decimal places", () => {
    const sized = sizeAdaptiveStakeFromEntry({
      entryPrice: 0.15,
      maxTradeStake: 33.333,
      systemMinStake: 1,
      systemMaxStake: 200,
      remainingBudget: 300,
    });
    assert.equal(sized.ok, true);
    if (sized.ok) assert.equal(sized.stake, 26.66);
  });

  it("computes remaining daily-loss budget from realized pnl", () => {
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
        realizedPnlToday: 10,
        userMaxDailyLoss: 70,
        systemMaxDailyLoss: 300,
      }),
      70,
    );
  });
});

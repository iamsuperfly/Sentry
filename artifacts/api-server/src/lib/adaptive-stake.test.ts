import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entryPriceEdge,
  sizeAdaptiveStakeFromEntry,
  stakeFractionFromStrength,
  stakeStrengthFromEdge,
} from "./adaptive-stake.ts";

describe("entry-price adaptive stake", () => {
  it("computes edge as 0.50 minus the bought outcome price", () => {
    assert.equal(entryPriceEdge(0.4), 0.1);
    assert.equal(entryPriceEdge(0.42), 0.08);
    assert.equal(entryPriceEdge(0), null);
  });

  it("maps edge to strength 0.50 + edge (not confidence)", () => {
    assert.equal(stakeStrengthFromEdge(0.08), 0.58);
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
    const cheapish = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.42 });
    assert.equal(cheapish.ok, true);
    if (cheapish.ok) {
      assert.equal(cheapish.fraction, 0.3);
      assert.equal(cheapish.stake, 15);
    }
    const mid = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.3 });
    assert.equal(mid.ok, true);
    if (mid.ok) {
      assert.equal(mid.fraction, 0.4);
      assert.equal(mid.stake, 20);
    }
    const veryCheap = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.15 });
    assert.equal(veryCheap.ok, true);
    if (veryCheap.ok) {
      assert.equal(veryCheap.fraction, 0.8);
      assert.equal(veryCheap.stake, 40);
    }
    const nearFair = sizeAdaptiveStakeFromEntry({ ...base, entryPrice: 0.49 });
    assert.equal(nearFair.ok, true);
    if (nearFair.ok) {
      assert.equal(nearFair.fraction, 0.25);
      assert.equal(nearFair.stake, 12.5);
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
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planOutcomeSell } from "./outcome-sell.ts";

describe("complete-set sell planning", () => {
  it("sells held inventory when the balance is sufficient", () => {
    const plan = planOutcomeSell({
      desiredSide: "YES",
      desiredQuantity: 10,
      heldQuantity: 10,
      snappedQuantity: 10,
    });
    assert.equal(plan.ok, true);
    if (plan.ok) {
      assert.equal(plan.mode, "sell_held");
      assert.equal(plan.mintQuantity, 0);
    }
  });

  it("mints a complete set when the held balance is short", () => {
    const plan = planOutcomeSell({
      desiredSide: "NO",
      desiredQuantity: 8,
      heldQuantity: 3,
      snappedQuantity: 8,
    });
    assert.equal(plan.ok, true);
    if (plan.ok && plan.mode === "mint_complete_set") {
      assert.equal(plan.mintQuantity, 5);
      assert.equal(plan.oppositeSide, "YES");
      assert.equal(plan.sellSide, "NO");
    }
  });

  it("never plans a zero-quantity sell", () => {
    const plan = planOutcomeSell({
      desiredSide: "YES",
      desiredQuantity: 0.0004,
      heldQuantity: 0,
      snappedQuantity: 0,
    });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.code, "invalid_lot");
  });
});

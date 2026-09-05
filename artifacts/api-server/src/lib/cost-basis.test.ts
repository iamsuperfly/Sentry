import assert from "node:assert/strict";
import test from "node:test";
import { realizedStakeBasis, soldCostBasis } from "./cost-basis.ts";

test("full fill keeps requested stake", () => {
  assert.equal(
    realizedStakeBasis({
      requestedStake: 28,
      filledContracts: 40,
      plannedContracts: 40,
      limitPrice: 0.7,
    }),
    28,
  );
});

test("partial fill uses filled * limit, capped at requested stake", () => {
  assert.equal(
    realizedStakeBasis({
      requestedStake: 28,
      filledContracts: 10,
      plannedContracts: 40,
      limitPrice: 0.7,
    }),
    7,
  );
});

test("partial fill without price scales stake by fill ratio", () => {
  assert.equal(
    realizedStakeBasis({
      requestedStake: 40,
      filledContracts: 10,
      plannedContracts: 20,
      limitPrice: null,
    }),
    20,
  );
});

test("sold cost basis is proportional", () => {
  assert.equal(
    soldCostBasis({
      positionStake: 28,
      positionContracts: 40,
      soldContracts: 10,
    }),
    7,
  );
});

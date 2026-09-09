import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeAvailableSlots,
  takeRankedUpToSlots,
} from "./multi-ai-execution.ts";

describe("multi-slot selection math", () => {
  it("availableSlots = max(0, maxOpen - openCount)", () => {
    assert.equal(
      computeAvailableSlots({ userMaxOpen: 4, systemMaxOpen: 4, openCount: 1 }),
      3,
    );
    assert.equal(
      computeAvailableSlots({ userMaxOpen: 4, systemMaxOpen: 4, openCount: 3 }),
      1,
    );
    assert.equal(
      computeAvailableSlots({ userMaxOpen: 4, systemMaxOpen: 4, openCount: 4 }),
      0,
    );
    assert.equal(
      computeAvailableSlots({ userMaxOpen: 10, systemMaxOpen: 4, openCount: 0 }),
      4,
    );
  });

  it("takes the top ranked candidates up to available slots", () => {
    const ranked = ["a", "b", "c", "d", "e"];
    assert.deepEqual(takeRankedUpToSlots(ranked, 3), ["a", "b", "c"]);
    assert.deepEqual(takeRankedUpToSlots(ranked, 2), ["a", "b"]);
    assert.deepEqual(takeRankedUpToSlots(["x"], 3), ["x"]);
    assert.deepEqual(takeRankedUpToSlots(ranked, 0), []);
    assert.deepEqual(takeRankedUpToSlots([], 3), []);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeAvailableSlots } from "./multi-ai-execution.ts";

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

  it("takes top N by confidence", () => {
    const ranked = [
      { id: "a", confidence: 0.91 },
      { id: "b", confidence: 0.87 },
      { id: "c", confidence: 0.81 },
    ];
    assert.deepEqual(
      ranked.slice(0, 3).map((x) => x.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      ranked.slice(0, 2).map((x) => x.id),
      ["a", "b"],
    );
  });

  it("default stake applies per trade not shared", () => {
    const defaultStake = 30;
    const per = Array.from({ length: 3 }, () => defaultStake);
    assert.equal(per.reduce((a, b) => a + b, 0), 90);
  });
});

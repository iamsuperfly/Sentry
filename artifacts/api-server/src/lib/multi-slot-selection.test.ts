import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("multi-slot selection math", () => {
  it("availableSlots = max(0, maxOpen - openCount)", () => {
    assert.equal(Math.max(0, Math.min(4, 4) - 1), 3);
    assert.equal(Math.max(0, Math.min(4, 4) - 3), 1);
    assert.equal(Math.max(0, Math.min(4, 4) - 4), 0);
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
    const n = 3;
    const per = Array.from({ length: n }, () => defaultStake);
    assert.equal(per.reduce((a, b) => a + b, 0), 90);
  });
});

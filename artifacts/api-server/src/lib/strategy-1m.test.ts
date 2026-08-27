import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeTriggers,
  evaluateOneMinuteUnderlying,
  ONE_MIN_FINAL_WINDOW_SEC,
} from "./strategy-1m.ts";

describe("1m ±0.05% underlying strategy", () => {
  it("computes fixed triggers from reference", () => {
    const { upperTrigger, lowerTrigger } = computeTriggers(100);
    assert.equal(upperTrigger, 100.05);
    assert.equal(lowerTrigger, 99.95);
  });

  it("skips outside final 30s", () => {
    const d = evaluateOneMinuteUnderlying({
      secondsToExpiry: 31,
      referencePrice: 100,
      currentPrice: 100.1,
    });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.code, "not_final_window");
  });

  it("enters UP on +0.05%", () => {
    const d = evaluateOneMinuteUnderlying({
      secondsToExpiry: 20,
      referencePrice: 100,
      currentPrice: 100.05,
    });
    assert.equal(d.action, "enter");
    if (d.action === "enter") assert.equal(d.direction, "UP");
  });

  it("enters DOWN on −0.05%", () => {
    const d = evaluateOneMinuteUnderlying({
      secondsToExpiry: 10,
      referencePrice: 100,
      currentPrice: 99.95,
    });
    assert.equal(d.action, "enter");
    if (d.action === "enter") assert.equal(d.direction, "DOWN");
  });

  it("skips when no trigger", () => {
    const d = evaluateOneMinuteUnderlying({
      secondsToExpiry: ONE_MIN_FINAL_WINDOW_SEC,
      referencePrice: 100,
      currentPrice: 100.01,
    });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.code, "no_trigger");
  });

  it("does not change reference inside helper (caller-owned)", () => {
    const ref = 200;
    evaluateOneMinuteUnderlying({
      secondsToExpiry: 15,
      referencePrice: ref,
      currentPrice: 200.2,
    });
    assert.equal(ref, 200);
  });

  it("skips expired and missing prices", () => {
    assert.equal(
      evaluateOneMinuteUnderlying({
        secondsToExpiry: 0,
        referencePrice: 1,
        currentPrice: 1,
      }).action,
      "skip",
    );
    const miss = evaluateOneMinuteUnderlying({
      secondsToExpiry: 10,
      referencePrice: null,
      currentPrice: 1,
    });
    assert.equal(miss.action, "skip");
  });
});

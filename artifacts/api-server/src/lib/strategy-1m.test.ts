import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyAdjacentMoves,
  evaluateOneMinuteVote,
  ONE_MIN_MIN_SECONDS_TO_EXPIRY,
  voteOneMinuteDirection,
} from "./strategy-1m.ts";
import { marketEligibleForOneMin } from "./one-min-runtime.ts";

describe("1m Binance vote", () => {
  it("follows 3 UP / 1 DOWN", () => {
    assert.equal(voteOneMinuteDirection(3, 1), "UP");
    const d = evaluateOneMinuteVote({
      secondsToExpiry: 40,
      prices: [100, 101, 102, 101.5, 103],
    });
    assert.equal(d.action, "enter");
    if (d.action === "enter") assert.equal(d.direction, "UP");
  });

  it("follows 3 DOWN / 1 UP", () => {
    assert.equal(voteOneMinuteDirection(1, 3), "DOWN");
    const d = evaluateOneMinuteVote({
      secondsToExpiry: 40,
      prices: [100, 99, 98, 98.5, 97],
    });
    assert.equal(d.action, "enter");
    if (d.action === "enter") assert.equal(d.direction, "DOWN");
  });

  it("skips 2-2 ties", () => {
    assert.equal(voteOneMinuteDirection(2, 2), "SKIP");
    const d = evaluateOneMinuteVote({
      secondsToExpiry: 40,
      prices: [100, 101, 100, 101, 100],
    });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.code, "tied_moves");
  });

  it("fades 4 UP and 4 DOWN", () => {
    assert.equal(voteOneMinuteDirection(4, 0), "DOWN");
    assert.equal(voteOneMinuteDirection(0, 4), "UP");
    const up = evaluateOneMinuteVote({
      secondsToExpiry: 45,
      prices: [100, 101, 102, 103, 104],
    });
    assert.equal(up.action, "enter");
    if (up.action === "enter") assert.equal(up.direction, "DOWN");
    const down = evaluateOneMinuteVote({
      secondsToExpiry: 45,
      prices: [104, 103, 102, 101, 100],
    });
    assert.equal(down.action, "enter");
    if (down.action === "enter") assert.equal(down.direction, "UP");
  });

  it("requires left >= 30", () => {
    const d = evaluateOneMinuteVote({
      secondsToExpiry: ONE_MIN_MIN_SECONDS_TO_EXPIRY - 1,
      prices: [100, 101, 102, 103, 104],
    });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.code, "too_close_to_expiry");
    const ok = evaluateOneMinuteVote({
      secondsToExpiry: 30,
      prices: [100, 101, 102, 101.5, 103],
    });
    assert.equal(ok.action, "enter");
  });

  it("fails closed without five prints", () => {
    const d = evaluateOneMinuteVote({
      secondsToExpiry: 40,
      prices: [100, 101, 102, 103],
    });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.code, "insufficient_prints");
  });

  it("fails closed on a flat adjacent print", () => {
    const classified = classifyAdjacentMoves([100, 101, 101, 102, 103]);
    assert.equal(classified.ok, false);
    if (!classified.ok) assert.equal(classified.code, "flat_move");
    const d = evaluateOneMinuteVote({
      secondsToExpiry: 40,
      prices: [100, 101, 101, 102, 103],
    });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.code, "flat_move");
  });

  it("uses the latest five prints when more exist", () => {
    const d = evaluateOneMinuteVote({
      secondsToExpiry: 50,
      prices: [1, 100, 101, 102, 103, 104],
    });
    assert.equal(d.action, "enter");
    if (d.action === "enter") {
      assert.deepEqual(d.prices, [100, 101, 102, 103, 104]);
      assert.equal(d.direction, "DOWN");
    }
  });

  it("treats left >= 30 as eligible and left < 30 as not", () => {
    const now = 1_700_000_000;
    const marketAt = (left: number) =>
      ({
        tradable: true,
        finalized: false,
        intervalSec: "60",
        tradingStart: String(now + left - 60),
        expiry: String(now + left),
        book: { yesBids: [], yesAsks: [], noBids: [], noAsks: [] },
      }) as never;
    assert.equal(marketEligibleForOneMin(marketAt(30), now), true);
    assert.equal(marketEligibleForOneMin(marketAt(29), now), false);
  });
});

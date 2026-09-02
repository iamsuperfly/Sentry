import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEarlyExit,
  yesLimitRawForSell,
  type EarlyExitPosition,
} from "./early-exit.ts";

function pos(over: Partial<EarlyExitPosition> = {}): EarlyExitPosition {
  return {
    tradeId: "t1",
    marketId: "m1",
    direction: "up",
    stake: 30,
    filledContracts: 40,
    entryPrice: 0.75,
    filledAt: "2026-09-02T12:00:00.000Z",
    submittedAt: "2026-09-02T12:00:00.000Z",
    marketExpiry: String(Math.floor(Date.parse("2026-09-02T12:00:00.000Z") / 1000) + 392),
    intervalSec: "900",
    status: "filled",
    ...over,
  };
}

test("time gate uses fill remaining, not market duration", () => {
  const p = pos();
  const filled = Math.floor(Date.parse(p.filledAt!) / 1000);
  const hold = evaluateEarlyExit({
    position: p,
    currentBid: 0.2,
    nowSec: filled + 195,
  });
  assert.equal(hold.action, "hold");
  if (hold.action === "hold") assert.equal(hold.code, "time_not_elapsed");

  const ready = evaluateEarlyExit({
    position: p,
    currentBid: 0.2,
    nowSec: filled + 196,
  });
  assert.equal(ready.action, "exit");
});

test("loss below 50% holds even after time elapses", () => {
  const p = pos({ stake: 30, filledContracts: 40 });
  const filled = Math.floor(Date.parse(p.filledAt!) / 1000);
  const result = evaluateEarlyExit({
    position: p,
    currentBid: 0.4,
    nowSec: filled + 300,
  });
  assert.equal(result.action, "hold");
  if (result.action === "hold") assert.equal(result.code, "loss_below_threshold");
});

test("loss at 50% of stake exits after time elapses", () => {
  const p = pos({ stake: 30, filledContracts: 40 });
  const filled = Math.floor(Date.parse(p.filledAt!) / 1000);
  const result = evaluateEarlyExit({
    position: p,
    currentBid: 0.375,
    nowSec: filled + 300,
  });
  assert.equal(result.action, "exit");
});

test("missing bid holds", () => {
  const p = pos();
  const filled = Math.floor(Date.parse(p.filledAt!) / 1000);
  const result = evaluateEarlyExit({
    position: p,
    currentBid: null,
    nowSec: filled + 300,
  });
  assert.equal(result.action, "hold");
  if (result.action === "hold") assert.equal(result.code, "no_bid");
});

test("1m windows are skipped", () => {
  const p = pos({ intervalSec: "60" });
  const filled = Math.floor(Date.parse(p.filledAt!) / 1000);
  const result = evaluateEarlyExit({
    position: p,
    currentBid: 0.1,
    nowSec: filled + 300,
  });
  assert.equal(result.action, "hold");
  if (result.action === "hold") assert.equal(result.code, "one_min_skipped");
});

test("SELL_NO price is complemented into YES terms", () => {
  const raw = yesLimitRawForSell({
    direction: "down",
    outcomeOwnBid: 0.4,
    decimals: 6,
  });
  assert.equal(raw, 600_000n);
});

test("SELL_YES price stays in YES terms", () => {
  const raw = yesLimitRawForSell({
    direction: "up",
    outcomeOwnBid: 0.4,
    decimals: 6,
  });
  assert.equal(raw, 400_000n);
});

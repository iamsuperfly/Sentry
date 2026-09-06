import assert from "node:assert/strict";
import test from "node:test";
import { formatEarlyExitMessage } from "./early-exit-manage.ts";

test("early-exit telegram copy is non-technical", () => {
  const text = formatEarlyExitMessage([
    {
      tradeId: "t1",
      marketId: "0xabc",
      symbol: "BTC-0xabc/up",
      status: "exited",
      reason: "Early-loss exit: elapsed 5386s ≥ 50% of 9553s remaining at fill, loss 18.2626 ≥ 50% of stake 28. Sold 39.106 contracts.",
      proceeds: 9.7374,
      pnl: -18.2626,
      soldContracts: 39.106,
    },
  ]);
  assert.match(text ?? "", /closed early/i);
  assert.match(text ?? "", /Proceeds:/);
  assert.match(text ?? "", /PnL:/);
  assert.doesNotMatch(text ?? "", /5386s/);
  assert.doesNotMatch(text ?? "", /9553s/);
});

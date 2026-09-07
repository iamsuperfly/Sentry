import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFinalizationMessage,
  isQuietZeroFillFinalization,
} from "./telegram-trade-format.ts";

const base = {
  symbol: "BTC",
  direction: "YES",
  stake: 10,
  explorerTxBaseUrl: "https://example.test/tx",
};

test("quiet-skips IOC zero-fill finalization copy", () => {
  assert.equal(
    isQuietZeroFillFinalization({
      status: "failed",
      errorMessage: "ImmediateOrCancelNoFill()",
      filledContracts: 0,
      pnl: 0,
    }),
    true,
  );
  const text = formatFinalizationMessage({
    ...base,
    status: "failed",
    errorMessage: "Immediate or cancel no fill",
    filledContracts: 0,
    pnl: 0,
  });
  assert.equal(text, "");
});

test("still reports genuine execution failures", () => {
  assert.equal(
    isQuietZeroFillFinalization({
      status: "failed",
      errorMessage: "RPC timeout from provider",
    }),
    false,
  );
  const text = formatFinalizationMessage({
    ...base,
    status: "failed",
    errorMessage: "RPC timeout from provider",
  });
  assert.match(text, /Trade closed/);
});

test("partial fills are not quiet-skipped", () => {
  assert.equal(
    isQuietZeroFillFinalization({
      status: "failed",
      errorMessage: "ImmediateOrCancelNoFill()",
      filledContracts: 4,
      pnl: -1,
    }),
    false,
  );
});

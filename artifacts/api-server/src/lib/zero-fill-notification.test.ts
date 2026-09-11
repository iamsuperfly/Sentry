import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFinalizationMessage,
  isQuietUnconfirmedExecutionFailure,
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

test("quiet-skips unconfirmed network-style execution failures", () => {
  for (const errorMessage of [
    "RPC timeout from provider",
    "SDK transport error",
    "allowance read failed",
    "ETIMEDOUT while submitting order",
  ]) {
    assert.equal(
      isQuietUnconfirmedExecutionFailure({
        status: "failed",
        errorMessage,
      }),
      true,
      errorMessage,
    );
    const text = formatFinalizationMessage({
      ...base,
      status: "failed",
      errorMessage,
    });
    assert.equal(text, "");
  }
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

test("confirmed on-chain rejection remains a safe zero-fill result", () => {
  assert.equal(
    isQuietUnconfirmedExecutionFailure({
      status: "failed",
      errorMessage: "PostOnlyWouldCross()",
    }),
    false,
  );
  assert.equal(
    formatFinalizationMessage({
      ...base,
      status: "failed",
      errorMessage: "PostOnlyWouldCross()",
    }),
    "",
  );
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikeInsufficientGas,
  looksLikePostOnlyWouldCross,
} from "./insufficient-gas.ts";

describe("insufficient gas classification", () => {
  it("matches genuine native-gas failures", () => {
    assert.equal(
      looksLikeInsufficientGas("InsufficientFundsError", "insufficient funds for gas * price + value"),
      true,
    );
    assert.equal(
      looksLikeInsufficientGas("error", "User wallet has insufficient STT."),
      true,
    );
    assert.equal(
      looksLikeInsufficientGas("error", "gas required exceeds allowance"),
      true,
    );
  });

  it("does not match unrelated failures", () => {
    assert.equal(looksLikeInsufficientGas("chain_read_failed", "rpc readContract"), false);
    assert.equal(looksLikeInsufficientGas("allowance", "ERC20 allowance too low"), false);
    assert.equal(looksLikeInsufficientGas("submission_failed", "ImmediateOrCancelNoFill()"), false);
    assert.equal(looksLikeInsufficientGas("insufficient_tusdc", "tUSDC balance 2"), false);
    assert.equal(looksLikeInsufficientGas("POST_ONLY", "PostOnlyWouldCross()"), false);
    assert.equal(looksLikeInsufficientGas("invalid_lot", "snaps to zero"), false);
    assert.equal(looksLikeInsufficientGas("market_expiry", "expires too soon"), false);
  });

  it("detects PostOnlyWouldCross", () => {
    assert.equal(looksLikePostOnlyWouldCross("ContractRevertError", "PostOnlyWouldCross()"), true);
  });
});

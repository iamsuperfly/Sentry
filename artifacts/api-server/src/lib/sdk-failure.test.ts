import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifySdkFailure,
  looksLikeSdkInvariant,
  redactSensitive,
} from "./sdk-failure.ts";

describe("sdk failure classification", () => {
  it("redacts private keys and 32-byte hex secrets", () => {
    const raw =
      "signer privateKey=0x1111111111111111111111111111111111111111111111111111111111111111 failed";
    const out = redactSensitive(raw);
    assert.doesNotMatch(out, /11111111/);
    assert.match(out, /redacted/);
  });

  it("treats InvariantError/unreachable without a hash as confirmed_failure", () => {
    const error = Object.assign(new Error("invariant violated: expected a value to be present"), {
      name: "InvariantError",
    });
    const c = classifySdkFailure(error, "IOC order");
    assert.equal(c.broadcastState, "confirmed_failure");
    assert.equal(c.operation, "IOC order");
    assert.match(c.message, /invariant violated/);
    assert.equal(c.hash, undefined);
  });

  it("treats unreachable transport errors as confirmed_failure", () => {
    const error = new Error("unreachable: no external wallet client after signer validation");
    const c = classifySdkFailure(error, "POST_ONLY order");
    assert.equal(c.broadcastState, "confirmed_failure");
    assert.equal(looksLikeSdkInvariant("", error.message), true);
  });

  it("keeps a hashed drop as uncertain", () => {
    const error = Object.assign(new Error("RPC connection dropped after send"), {
      transactionHash: "0x" + "ab".repeat(32),
    });
    const c = classifySdkFailure(error, "IOC order");
    assert.equal(c.broadcastState, "uncertain");
    assert.equal(c.hash, "0x" + "ab".repeat(32));
  });

  it("treats no-hash generic failures as confirmed_failure so the slot frees", () => {
    const c = classifySdkFailure(new Error("Somnia client exploded"), "Collateral approval");
    assert.equal(c.broadcastState, "confirmed_failure");
    assert.equal(c.hash, undefined);
  });
});

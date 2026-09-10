import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearWindowState,
  detectWindowChange,
  rememberWindow,
  windowKey,
} from "./market-window.ts";

describe("market window identity", () => {
  it("keys markets by marketId + pool + nonce", () => {
    assert.equal(
      windowKey({
        marketId: "0xABC",
        poolAddress: "0xPool",
        poolNonce: "3",
      }),
      "0xabc:0xpool:3",
    );
  });

  it("treats a reused pool with a new nonce as a new window", () => {
    const prev = {
      marketId: "0xold",
      poolAddress: "0xpool",
      poolNonce: "1",
    };
    const next = {
      marketId: "0xnew",
      poolAddress: "0xpool",
      poolNonce: "2",
    };
    const change = detectWindowChange(prev, next);
    assert.equal(change.changed, true);
    if (change.changed) assert.equal(change.reason, "new_market");
  });

  it("resets process window state when identity changes", () => {
    clearWindowState();
    const first = rememberWindow({
      marketId: "0x1",
      poolAddress: "0xpool",
      poolNonce: "1",
    });
    assert.equal(first.changed, true);
    const same = rememberWindow({
      marketId: "0x1",
      poolAddress: "0xpool",
      poolNonce: "1",
    });
    assert.equal(same.changed, false);
    const rolled = rememberWindow({
      marketId: "0x2",
      poolAddress: "0xpool",
      poolNonce: "2",
    });
    assert.equal(rolled.changed, true);
    clearWindowState();
  });
});

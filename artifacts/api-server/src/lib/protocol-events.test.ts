import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLiveMarketDelta } from "./protocol-events.ts";

describe("protocol live events", () => {
  it("emits market_live for a newly seen Trading market", () => {
    const event = classifyLiveMarketDelta({
      previous: null,
      next: {
        marketId: "0xabc",
        poolAddress: "0xpool",
        nonce: 3,
        clobStatus: "Trading",
      },
    });
    assert.equal(event?.kind, "market_live");
    assert.equal(event?.marketId, "0xabc");
  });

  it("emits locked/settlement without inventing a second strategy", () => {
    const locked = classifyLiveMarketDelta({
      previous: {
        status: "Trading",
        window: { marketId: "0xabc", poolAddress: "0xpool", poolNonce: "3" },
      },
      next: {
        marketId: "0xabc",
        poolAddress: "0xpool",
        nonce: 3,
        clobStatus: "Locked",
      },
    });
    assert.equal(locked?.kind, "locked");

    const resolved = classifyLiveMarketDelta({
      previous: {
        status: "Locked",
        window: { marketId: "0xabc", poolAddress: "0xpool", poolNonce: "3" },
      },
      next: {
        marketId: "0xabc",
        poolAddress: "0xpool",
        nonce: 3,
        clobStatus: "Resolved",
      },
    });
    assert.equal(resolved?.kind, "settlement");
  });

  it("emits new_window when the pool nonce/marketId rolls", () => {
    const event = classifyLiveMarketDelta({
      previous: {
        status: "Trading",
        window: { marketId: "0xold", poolAddress: "0xpool", poolNonce: "1" },
      },
      next: {
        marketId: "0xnew",
        poolAddress: "0xpool",
        nonce: 2,
        clobStatus: "Trading",
      },
    });
    assert.equal(event?.kind, "new_window");
  });

  it("ignores non-binary live rows", () => {
    const event = classifyLiveMarketDelta({
      previous: null,
      next: {
        marketType: "SPOT",
        marketId: "0xspot",
        poolAddress: "0xpool",
        nonce: 1,
        clobStatus: "Trading",
      },
    });
    assert.equal(event, null);
  });
});

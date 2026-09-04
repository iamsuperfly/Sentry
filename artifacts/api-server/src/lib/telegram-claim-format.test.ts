import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatClaimMessage } from "./telegram-claim-format.ts";

describe("formatClaimMessage", () => {
  it("hides skipped and failed rows and says no new claims when none succeeded", () => {
    const text = formatClaimMessage([
      { symbol: "BTC", direction: "up", status: "skipped", reason: "Losing position" },
      { symbol: "ETH", direction: "down", status: "failed", reason: "rpc" },
    ]);
    assert.equal(text, "No new claims.");
    assert.doesNotMatch(text, /skipped/i);
    assert.doesNotMatch(text, /Found:/);
  });

  it("lists only newly claimed positions", () => {
    const text = formatClaimMessage([
      {
        symbol: "BTC",
        direction: "up",
        status: "claimed",
        reason: "redeemed",
        payoutEstimate: 18.4,
        transactionHash: "0xabc",
      },
      { symbol: "ETH", direction: "down", status: "skipped", reason: "Losing position" },
    ]);
    assert.match(text, /Claimed 1 position/);
    assert.match(text, /BTC UP/);
    assert.match(text, /Payout: 18\.4/);
    assert.doesNotMatch(text, /ETH/);
    assert.doesNotMatch(text, /Skipped/);
  });
});

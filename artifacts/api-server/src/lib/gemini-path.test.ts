import assert from "node:assert/strict";
import test from "node:test";
import { marketEligibleForGemini } from "./gemini-path.ts";

function market(overrides: Record<string, unknown> = {}) {
  const now = 1_700_000_000;
  return {
    marketId: "0x1",
    asset: "BTC",
    tradable: true,
    finalized: false,
    intervalSec: "300",
    tradingStart: String(now - 180),
    expiry: String(now + 90),
    book: {
      yes: { bids: [], asks: [{ price: "0.51", quantity: "10" }] },
      no: { bids: [], asks: [{ price: "0.49", quantity: "10" }] },
    },
    ...overrides,
  } as never;
}

test("5m is eligible inside final 120s and not before", () => {
  const now = 1_700_000_000;
  assert.equal(
    marketEligibleForGemini(
      market({ expiry: String(now + 90), intervalSec: "300" }),
      now,
    ),
    true,
  );
  assert.equal(
    marketEligibleForGemini(
      market({
        expiry: String(now + 200),
        intervalSec: "300",
        tradingStart: String(now - 100),
      }),
      now,
    ),
    false,
  );
});

test("15m remains eligible outside the 5m window", () => {
  const now = 1_700_000_000;
  assert.equal(
    marketEligibleForGemini(
      market({
        intervalSec: "900",
        tradingStart: String(now - 100),
        expiry: String(now + 800),
      }),
      now,
    ),
    true,
  );
});

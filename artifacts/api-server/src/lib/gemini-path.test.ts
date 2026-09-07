import assert from "node:assert/strict";
import test from "node:test";
import {
  marketEligibleForGemini,
  toGeminiMarketInput,
} from "./gemini-path.ts";

function market(overrides: Record<string, unknown> = {}) {
  const now = 1_700_000_000;
  return {
    marketId: "0x1",
    asset: "BTC",
    strike: "68000",
    tradable: true,
    finalized: false,
    intervalSec: "300",
    decimals: 2,
    tradingStart: String(now - 210),
    expiry: String(now + 90),
    book: {
      yesBids: [],
      yesAsks: [{ price: "0.51", quantity: "10" }],
      noBids: [],
      noAsks: [{ price: "0.49", quantity: "10" }],
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

test("1m markets do not enter the Groq eligibility path", () => {
  const now = 1_700_000_000;
  assert.equal(
    marketEligibleForGemini(
      market({
        intervalSec: "60",
        tradingStart: String(now - 30),
        expiry: String(now + 30),
      }),
      now,
    ),
    false,
  );
});

test("strike-0 opening markets are eligible only after a resolved reference price", () => {
  const now = 1_700_000_000;
  const opening = {
    intervalSec: "3600",
    tradingStart: String(now - 100),
    expiry: String(now + 3500),
    strike: "0",
  };
  assert.equal(
    marketEligibleForGemini(market({ ...opening, referencePrice: undefined }), now),
    false,
  );
  assert.equal(
    marketEligibleForGemini(
      market({
        ...opening,
        referenceType: "opening",
        referencePrice: 80346.7,
        referenceDecimals: 2,
      }),
      now,
    ),
    true,
  );
});

test("maps the DreamDEX strike and normalized ask depth into AI input", () => {
  const now = 1_700_000_000;
  const input = toGeminiMarketInput(
    market({
      strike: "68000",
      decimals: 6,
      book: {
        yesBids: [],
        yesAsks: [{ price: "510000", quantity: "12000000" }],
        noBids: [],
        noAsks: [{ price: "490000", quantity: "8000000" }],
      },
    }),
    now,
  );

  assert.equal(input.strike, "68000");
  assert.equal(input.yesAskQuantity, 12);
  assert.equal(input.noAskQuantity, 8);
  assert.equal(input.topAskQuantity, 12);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateReferenceGapBps,
  normalizeOracleNumericValue,
  parseFixedStrike,
  referencePriceForMarket,
  resolveMarketReferencePrice,
} from "./reference-price.ts";

function openingMarket(overrides: Record<string, unknown> = {}) {
  return {
    marketId: "0xmarket",
    asset: "BTC",
    strike: "0",
    intervalSec: "3600",
    creator: "0x0000000000000000000000000000000000000001",
    ...overrides,
  } as never;
}

function clientFor(input: {
  numericValue?: string | null;
  voidReason?: number | null;
  resolvedAt?: string | null;
  numericDecimals?: bigint | number;
  series?: Array<{ seriesId: number; asset: string; intervalSec: string }>;
}) {
  return {
    getMarketResolution: async () => ({
      reference: { oracleQuestionId: "42" },
      openingAnswer: {
        oracleQuestionId: "42",
        numericValue:
          input.numericValue === undefined ? "8034670" : input.numericValue,
        voidReason: input.voidReason ?? null,
        resolvedAt: input.resolvedAt ?? "123",
      },
    }),
    getMarketCreator: async () => ({
      series: input.series ?? [
        { seriesId: 7, asset: "BTC", intervalSec: "3600" },
      ],
    }),
    getViemClient: () => ({
      readContract: async () =>
        [
          "0x0000000000000000000000000000000000000002",
          "BTC",
          input.numericDecimals === undefined ? 2n : input.numericDecimals,
          3600n,
          60n,
        ] as never,
    }),
  };
}

test("normalizes 2-decimal BTC opening answer", () => {
  assert.equal(normalizeOracleNumericValue("8034670", 2), 80346.7);
});

test("normalizes 8-decimal BTC opening answer", () => {
  assert.equal(normalizeOracleNumericValue("7961075000000", 8), 79610.75);
});

test("normalizes 2-decimal ETH opening answer", () => {
  assert.equal(normalizeOracleNumericValue("251491", 2), 2514.91);
});

test("normalizes 8-decimal ETH opening answer", () => {
  assert.equal(normalizeOracleNumericValue("245058000000", 8), 2450.58);
});

test("calculates signed gap from normalized opening price", () => {
  assert.equal(calculateReferenceGapBps(80_750, 80_346.7), 50.19);
});

test("does not use collateral decimals or an implicit /100 scale", () => {
  assert.equal(normalizeOracleNumericValue("7961075000000", 6), 7_961_075);
  assert.equal(normalizeOracleNumericValue("7961075000000", 18), 0.000007961075);
});

test("resolves an opening reference through the MarketReferenceLink and series scale", async () => {
  const result = await resolveMarketReferencePrice(
    openingMarket(),
    clientFor({ numericValue: "8034670", numericDecimals: 2n }),
  );
  assert.deepEqual(result, {
    referenceType: "opening",
    referencePrice: 80346.7,
    referenceDecimals: 2,
  });
});

test("missing opening answer fails closed", async () => {
  const result = await resolveMarketReferencePrice(
    openingMarket(),
    clientFor({ numericValue: null }),
  );
  assert.equal(result, null);
});

test("voided opening answer fails closed", async () => {
  const result = await resolveMarketReferencePrice(
    openingMarket(),
    clientFor({ voidReason: 1 }),
  );
  assert.equal(result, null);
});

test("unknown numericDecimals fails closed", async () => {
  const result = await resolveMarketReferencePrice(
    openingMarket(),
    clientFor({ numericDecimals: Number.NaN }),
  );
  assert.equal(result, null);
});

test("fixed-strike markets retain their existing reference price", async () => {
  const result = await resolveMarketReferencePrice(
    openingMarket({ strike: "68000", creator: null }),
    clientFor({}),
  );
  assert.deepEqual(result, {
    referenceType: "strike",
    referencePrice: 68000,
    referenceDecimals: null,
  });
  assert.equal(parseFixedStrike("68000"), 68000);
  assert.equal(referencePriceForMarket({ strike: "68000" }), 68000);
});

test("a malformed reference market does not affect other candidates", async () => {
  const results = await Promise.all(
    [
      resolveMarketReferencePrice(
        openingMarket({ marketId: "bad" }),
        clientFor({ numericValue: null }),
      ),
      resolveMarketReferencePrice(
        openingMarket({ marketId: "good", strike: "68000", creator: null }),
        clientFor({}),
      ),
    ],
  );
  assert.equal(results[0], null);
  assert.equal(results[1]?.referencePrice, 68000);
});
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachMarketWindowMeta,
  resolveMarketDurationSeconds,
} from "./decision-market-meta.ts";
import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";
import type { StrategyDecision } from "./strategy.ts";

function decision(
  overrides: Partial<StrategyDecision> = {},
): StrategyDecision {
  return {
    strategyName: "edge-taker-v1",
    strategyVersion: "1.0.0",
    action: "enter",
    marketId: "0xm1",
    asset: "BTC",
    marketAddress: "0xm",
    poolAddress: "0xp",
    poolNonce: "1",
    expiry: "1700000300",
    direction: "YES",
    limitPriceHint: 0.4,
    edge: 0.1,
    edgeThreshold: 0.08,
    fairProbability: 0.5,
    book: {
      yesBid: null,
      yesAsk: 0.4,
      noBid: null,
      noAsk: null,
      yesSpread: null,
    },
    secondsToExpiry: 300,
    tradable: true,
    finalized: false,
    indexerStatus: "Trading",
    onchainStatus: 1,
    reason: "test",
    skipCode: null,
    ...overrides,
  };
}

function market(
  overrides: Partial<DreamdexMarketDiagnostic> = {},
): DreamdexMarketDiagnostic {
  return {
    marketId: "0xm1",
    marketAddress: "0xm",
    poolAddress: "0xp",
    poolNonce: "1",
    asset: "BTC",
    question: "q",
    oracleQuestion: null,
    strike: "0",
    tradingStart: "1700000000",
    expiry: "1700000300",
    intervalSec: "300",
    indexerStatus: "Trading",
    onchainStatus: 1,
    tradable: true,
    finalized: false,
    isResolved: false,
    isVoided: false,
    winningOutcome: null,
    collateral: "0xc",
    decimals: 6,
    book: { yesBids: [], yesAsks: [], noBids: [], noAsks: [] },
    ...overrides,
  };
}

describe("attachMarketWindowMeta", () => {
  it("copies tradingStart and intervalSec from the matching market", () => {
    const d = attachMarketWindowMeta(decision(), [market()]);
    assert.equal(d.tradingStart, "1700000000");
    assert.equal(d.intervalSec, "300");
    assert.equal(d.expiry, "1700000300");
  });

  it("does not invent a window when market is missing", () => {
    const d = attachMarketWindowMeta(decision({ marketId: "0xother" }), [
      market(),
    ]);
    assert.equal(d.tradingStart, "");
    assert.equal(d.intervalSec, null);
  });
});

describe("resolveMarketDurationSeconds", () => {
  it("prefers intervalSec", () => {
    assert.equal(
      resolveMarketDurationSeconds({
        intervalSec: "1800",
        tradingStart: "1",
        expiry: "301",
      }),
      1800,
    );
  });

  it("falls back to tradingStart → expiry", () => {
    assert.equal(
      resolveMarketDurationSeconds({
        intervalSec: null,
        tradingStart: "1700000000",
        expiry: "1700001800",
      }),
      1800,
    );
  });

  it("returns null without inventing", () => {
    assert.equal(
      resolveMarketDurationSeconds({
        intervalSec: null,
        tradingStart: null,
        expiry: "1700001800",
      }),
      null,
    );
  });
});

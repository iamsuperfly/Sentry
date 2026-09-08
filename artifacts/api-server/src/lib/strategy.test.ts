import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";
import {
  DEFAULT_EDGE_THRESHOLD,
  DEFAULT_MIN_SECONDS_TO_EXPIRY,
  evaluateMarket,
  evaluateMarkets,
  extractBookTop,
  FAIR_PROBABILITY,
  secondsToExpiry,
  STRATEGY_NAME,
} from "./strategy.ts";

function market(
  overrides: Partial<DreamdexMarketDiagnostic> &
    Pick<DreamdexMarketDiagnostic, "marketId">,
): DreamdexMarketDiagnostic {
  const now = Math.floor(Date.now() / 1000);
  return {
    marketId: overrides.marketId,
    marketAddress: overrides.marketAddress ?? "0xmarket",
    poolAddress: overrides.poolAddress ?? "0xpool",
    poolNonce: overrides.poolNonce ?? "1",
    asset: overrides.asset ?? "BTC",
    question: overrides.question ?? "test",
    oracleQuestion: overrides.oracleQuestion ?? null,
    strike: overrides.strike ?? "0",
    tradingStart: overrides.tradingStart ?? String(now - 60),
    expiry: overrides.expiry ?? String(now + 900),
    indexerStatus: overrides.indexerStatus ?? "Trading",
    onchainStatus: overrides.onchainStatus ?? 1,
    tradable: overrides.tradable ?? true,
    finalized: overrides.finalized ?? false,
    intervalSec: overrides.intervalSec ?? null,
    isResolved: overrides.isResolved ?? false,
    isVoided: overrides.isVoided ?? false,
    winningOutcome: overrides.winningOutcome ?? null,
    collateral: overrides.collateral ?? "0xtusdc",
    decimals: overrides.decimals ?? 6,
    book: overrides.book ?? {
      yesBids: [],
      yesAsks: [],
      noBids: [],
      noAsks: [],
    },
  };
}

const p = (human: number, decimals = 6) =>
  String(Math.round(human * 10 ** decimals));

describe("secondsToExpiry", () => {
  it("handles unix seconds", () => {
    assert.equal(secondsToExpiry("1000", 900), 100);
  });

  it("handles unix milliseconds", () => {
    assert.equal(secondsToExpiry("1000000000000", 900_000_000), 100_000_000);
  });
});

describe("extractBookTop", () => {
  it("scales prices by market decimals", () => {
    const top = extractBookTop(
      market({
        marketId: "0x1",
        decimals: 6,
        book: {
          yesBids: [{ price: p(0.4), quantity: "1" }],
          yesAsks: [{ price: p(0.42), quantity: "2" }],
          noBids: [],
          noAsks: [{ price: p(0.55), quantity: "1" }],
        },
      }),
    );
    assert.equal(top.yesBid, 0.4);
    assert.equal(top.yesAsk, 0.42);
    assert.equal(top.noAsk, 0.55);
    assert.ok(top.yesSpread !== null && Math.abs(top.yesSpread - 0.02) < 1e-9);
  });
});

describe("evaluateMarket", () => {
  it("skips unsupported assets", () => {
    const d = evaluateMarket(market({ marketId: "0x1", asset: "SOL" }));
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "unsupported_asset");
  });

  it("skips finalized markets", () => {
    const d = evaluateMarket(
      market({ marketId: "0x1", finalized: true }),
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "finalized");
  });

  it("skips non-tradable markets", () => {
    const d = evaluateMarket(
      market({ marketId: "0x1", tradable: false, onchainStatus: 2 }),
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "not_tradable");
  });

  it("skips near expiry", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0x1",
        expiry: String(now + 60),
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "near_expiry");
  });

  it("enters YES when ask is sufficiently below fair", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0xyes",
        expiry: String(now + 900),
        book: {
          yesBids: [{ price: p(0.4), quantity: "1" }],
          yesAsks: [{ price: p(0.4), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "enter");
    assert.equal(d.direction, "YES");
    assert.equal(d.limitPriceHint, 0.4);
    assert.ok(d.edge !== null && d.edge >= DEFAULT_EDGE_THRESHOLD);
    assert.equal(d.strategyName, STRATEGY_NAME);
    assert.equal(d.fairProbability, FAIR_PROBABILITY);
  });

  it("enters NO when NO ask is cheap", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0xno",
        expiry: String(now + 900),
        book: {
          yesBids: [],
          yesAsks: [],
          noBids: [],
          noAsks: [{ price: p(0.4), quantity: "1" }],
        },
      }),
      now,
    );
    assert.equal(d.action, "enter");
    assert.equal(d.direction, "NO");
  });

  it("enters NO when YES ask is sufficiently above fair", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0xno2",
        expiry: String(now + 900),
        book: {
          yesBids: [{ price: p(0.55), quantity: "1" }],
          yesAsks: [{ price: p(0.6), quantity: "1" }],
          noBids: [],
          noAsks: [{ price: p(0.45), quantity: "1" }],
        },
      }),
      now,
    );
    assert.equal(d.action, "enter");
    assert.equal(d.direction, "NO");
  });

  it("skips when no edge", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0xflat",
        expiry: String(now + 900),
        book: {
          yesBids: [{ price: p(0.49), quantity: "1" }],
          yesAsks: [{ price: p(0.51), quantity: "1" }],
          noBids: [],
          noAsks: [{ price: p(0.51), quantity: "1" }],
        },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "no_edge");
  });

  it("skips wide spread", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0xwide",
        expiry: String(now + 900),
        book: {
          yesBids: [{ price: p(0.3), quantity: "1" }],
          yesAsks: [{ price: p(0.45), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "wide_spread");
  });

  it("skips with no liquidity", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0xempty",
        expiry: String(now + 900),
        book: { yesBids: [], yesAsks: [], noBids: [], noAsks: [] },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "no_liquidity");
  });
});

describe("evaluateMarkets", () => {
  it("sorts enters by least time remaining then marketId", () => {
    const now = 1_700_000_000;
    const run = evaluateMarkets(
      [
        market({
          marketId: "0xfar",
          expiry: String(now + 900),
          intervalSec: "900",
          tradingStart: String(now),
          book: {
            yesBids: [],
            yesAsks: [{ price: p(0.35), quantity: "1" }],
            noBids: [],
            noAsks: [],
          },
        }),
        market({
          marketId: "0xnear",
          expiry: String(now + 400),
          intervalSec: "900",
          tradingStart: String(now - 500),
          book: {
            yesBids: [],
            yesAsks: [{ price: p(0.41), quantity: "1" }],
            noBids: [],
            noAsks: [],
          },
        }),
        market({
          marketId: "0xskip",
          finalized: true,
          expiry: String(now + 900),
        }),
      ],
      now,
    );
    assert.equal(run.enterCount, 2);
    assert.equal(run.skipCount, 1);
    assert.equal(run.decisions[0]?.marketId, "0xnear");
    assert.equal(run.decisions[1]?.marketId, "0xfar");
  });

  it("respects custom minSecondsToExpiry", () => {
    const now = 1_700_000_000;
    const run = evaluateMarkets(
      [
        market({
          marketId: "0xnear",
          expiry: String(now + 200),
          book: {
            yesBids: [],
            yesAsks: [{ price: p(0.3), quantity: "1" }],
            noBids: [],
            noAsks: [],
          },
        }),
      ],
      now,
      {
        edgeThreshold: DEFAULT_EDGE_THRESHOLD,
        minSecondsToExpiry: DEFAULT_MIN_SECONDS_TO_EXPIRY,
        maxSpread: 0.1,
        supportedAssets: new Set(["BTC", "ETH"]),
      },
    );
    assert.equal(run.enterCount, 0);
    assert.equal(run.decisions[0]?.skipCode, "near_expiry");
  });

  it("allows 5m markets with at least 120s remaining", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0x5m",
        intervalSec: "300",
        tradingStart: String(now - 150),
        expiry: String(now + 150),
        book: {
          yesBids: [],
          yesAsks: [{ price: p(0.4), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "enter");
    assert.equal(d.direction, "YES");
  });

  it("skips 5m markets under 120s remaining", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0x5m-late",
        intervalSec: "300",
        tradingStart: String(now - 220),
        expiry: String(now + 80),
        book: {
          yesBids: [],
          yesAsks: [{ price: p(0.4), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "near_expiry");
  });

  it("keeps the 300s gate on 15m+", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0x15m",
        intervalSec: "900",
        tradingStart: String(now - 700),
        expiry: String(now + 200),
        book: {
          yesBids: [],
          yesAsks: [{ price: p(0.4), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "near_expiry");
  });

  it("does not let edge-taker trade 1m markets", () => {
    const now = 1_700_000_000;
    const d = evaluateMarket(
      market({
        marketId: "0x1m",
        intervalSec: "60",
        tradingStart: String(now - 10),
        expiry: String(now + 50),
        book: {
          yesBids: [],
          yesAsks: [{ price: p(0.4), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "one_min_market");
  });
});

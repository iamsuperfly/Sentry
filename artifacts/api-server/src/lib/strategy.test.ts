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

/** 0.40 probability at 6 decimals */
const p = (human: number, decimals = 6) =>
  String(Math.round(human * 10 ** decimals));

describe("secondsToExpiry", () => {
  it("handles unix seconds", () => {
    assert.equal(secondsToExpiry("1000", 900), 100);
  });

  it("handles unix milliseconds", () => {
    assert.equal(secondsToExpiry("1000000", 900), 100);
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
  const now = 1_700_000_000;

  it("skips finalized markets", () => {
    const d = evaluateMarket(
      market({
        marketId: "0xf",
        finalized: true,
        indexerStatus: "Finalized",
        tradable: false,
        onchainStatus: 4,
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "finalized");
  });

  it("skips non-tradable markets", () => {
    const d = evaluateMarket(
      market({
        marketId: "0xnt",
        tradable: false,
        onchainStatus: 2,
        indexerStatus: "Locked",
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "not_tradable");
  });

  it("skips near expiry", () => {
    const d = evaluateMarket(
      market({
        marketId: "0xnear",
        expiry: String(now + DEFAULT_MIN_SECONDS_TO_EXPIRY - 10),
        book: {
          yesBids: [],
          yesAsks: [{ price: p(0.3), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "near_expiry");
  });

  it("skips empty books", () => {
    const d = evaluateMarket(
      market({ marketId: "0xempty", expiry: String(now + 900) }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "no_liquidity");
  });

  it("enters YES when yesAsk is sufficiently below fair", () => {
    const yesAsk = FAIR_PROBABILITY - DEFAULT_EDGE_THRESHOLD; // 0.42
    const d = evaluateMarket(
      market({
        marketId: "0xyes",
        expiry: String(now + 900),
        book: {
          yesBids: [{ price: p(0.4), quantity: "1" }],
          yesAsks: [{ price: p(yesAsk), quantity: "5" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "enter");
    assert.equal(d.direction, "YES");
    assert.equal(d.limitPriceHint, yesAsk);
    assert.equal(d.strategyName, STRATEGY_NAME);
    assert.ok((d.edge ?? 0) >= DEFAULT_EDGE_THRESHOLD - 1e-9);
    assert.equal(d.skipCode, null);
  });

  it("enters NO when noAsk is cheap", () => {
    const d = evaluateMarket(
      market({
        marketId: "0xno",
        asset: "ETH",
        expiry: String(now + 900),
        book: {
          yesBids: [],
          yesAsks: [{ price: p(0.55), quantity: "1" }],
          noBids: [],
          noAsks: [{ price: p(0.4), quantity: "3" }],
        },
      }),
      now,
    );
    assert.equal(d.action, "enter");
    assert.equal(d.direction, "NO");
    assert.equal(d.limitPriceHint, 0.4);
  });

  it("enters NO when yesAsk is expensive", () => {
    const d = evaluateMarket(
      market({
        marketId: "0xhigh",
        expiry: String(now + 900),
        book: {
          yesBids: [{ price: p(0.58), quantity: "1" }],
          yesAsks: [{ price: p(0.6), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "enter");
    assert.equal(d.direction, "NO");
  });

  it("skips when prices are near fair (no edge)", () => {
    const d = evaluateMarket(
      market({
        marketId: "0xfair",
        expiry: String(now + 900),
        book: {
          yesBids: [{ price: p(0.49), quantity: "1" }],
          yesAsks: [{ price: p(0.51), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "no_edge");
  });

  it("skips wide spreads", () => {
    const d = evaluateMarket(
      market({
        marketId: "0xwide",
        expiry: String(now + 900),
        book: {
          yesBids: [{ price: p(0.3), quantity: "1" }],
          yesAsks: [{ price: p(0.5), quantity: "1" }],
          noBids: [],
          noAsks: [],
        },
      }),
      now,
    );
    assert.equal(d.action, "skip");
    assert.equal(d.skipCode, "wide_spread");
  });
});

describe("evaluateMarkets", () => {
  it("sorts enters by edge descending and counts skips", () => {
    const now = 1_700_000_000;
    const result = evaluateMarkets(
      [
        market({
          marketId: "0xa",
          expiry: String(now + 900),
          book: {
            yesBids: [],
            yesAsks: [{ price: p(0.4), quantity: "1" }],
            noBids: [],
            noAsks: [],
          },
        }),
        market({
          marketId: "0xb",
          expiry: String(now + 900),
          book: {
            yesBids: [],
            yesAsks: [{ price: p(0.35), quantity: "1" }],
            noBids: [],
            noAsks: [],
          },
        }),
        market({
          marketId: "0xc",
          finalized: true,
          tradable: false,
          indexerStatus: "Finalized",
          onchainStatus: 4,
        }),
      ],
      now,
    );
    assert.equal(result.enterCount, 2);
    assert.equal(result.skipCount, 1);
    assert.equal(result.decisions[0]?.marketId, "0xb");
    assert.ok((result.decisions[0]?.edge ?? 0) > (result.decisions[1]?.edge ?? 0));
  });
});

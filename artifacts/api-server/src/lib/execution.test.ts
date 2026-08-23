import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertLiveSubmitAllowed,
  buildIdempotencyKey,
  buildTradeIntent,
  canTransition,
  mapDirection,
  planLiveSubmission,
  transitionIntent,
} from "./execution.ts";
import { evaluateRisk } from "./risk.ts";
import type { StrategyDecision } from "./strategy.ts";

function enterDecision(
  overrides: Partial<StrategyDecision> = {},
): StrategyDecision {
  return {
    strategyName: "edge-taker-v1",
    strategyVersion: "1.0.0",
    action: "enter",
    marketId: "0xabc",
    asset: "BTC",
    marketAddress: "0xmarket",
    poolAddress: "0xpool",
    poolNonce: "1",
    expiry: "2000000000",
    direction: "YES",
    limitPriceHint: 0.4,
    edge: 0.1,
    edgeThreshold: 0.08,
    fairProbability: 0.5,
    book: {
      yesBid: 0.38,
      yesAsk: 0.4,
      noBid: null,
      noAsk: null,
      yesSpread: 0.02,
    },
    secondsToExpiry: 600,
    tradable: true,
    finalized: false,
    indexerStatus: "Trading",
    onchainStatus: 1,
    reason: "test",
    skipCode: null,
    ...overrides,
  };
}

const baseSettings = {
  tradingEnabled: true,
  defaultStake: 1,
  maxTradeStake: 5,
  maxDailyLoss: 10,
  maxOpenPositions: 1,
  realizedPnlToday: 0,
  openPositionCount: 0,
  collateralBalance: 20,
};

describe("risk", () => {
  it("rejects when trading disabled", () => {
    const r = evaluateRisk({
      stake: 1,
      limitPrice: 0.4,
      settings: { ...baseSettings, tradingEnabled: false },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "trading_disabled");
  });

  it("rejects max open positions", () => {
    const r = evaluateRisk({
      stake: 1,
      limitPrice: 0.4,
      settings: { ...baseSettings, openPositionCount: 1 },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "max_open_positions");
  });

  it("rejects daily loss breach", () => {
    const r = evaluateRisk({
      stake: 1,
      limitPrice: 0.4,
      settings: { ...baseSettings, realizedPnlToday: -10 },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "max_daily_loss");
  });

  it("rejects insufficient collateral", () => {
    const r = evaluateRisk({
      stake: 5,
      limitPrice: 0.4,
      settings: { ...baseSettings, collateralBalance: 1 },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "insufficient_collateral");
  });

  it("accepts valid stake and sizes contracts", () => {
    const r = evaluateRisk({
      stake: 2,
      limitPrice: 0.4,
      settings: baseSettings,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.stake, 2);
      assert.equal(r.contracts, 5);
    }
  });
});

describe("idempotency + intent build", () => {
  it("maps YES/NO to up/down", () => {
    assert.equal(mapDirection("YES"), "up");
    assert.equal(mapDirection("NO"), "down");
  });

  it("builds stable idempotency keys", () => {
    const a = buildIdempotencyKey({
      userId: "u1",
      marketId: "0xabc",
      strategyName: "edge-taker-v1",
      strategyVersion: "1.0.0",
      direction: "YES",
    });
    const b = buildIdempotencyKey({
      userId: "u1",
      marketId: "0xabc",
      strategyName: "edge-taker-v1",
      strategyVersion: "1.0.0",
      direction: "YES",
    });
    assert.equal(a, b);
  });

  it("rejects skip decisions", () => {
    const result = buildTradeIntent({
      userId: "u1",
      walletAddress: "0xwallet",
      decision: enterDecision({ action: "skip", direction: null, limitPriceHint: null }),
      settings: baseSettings,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_enter");
  });

  it("rejects duplicate active intents", () => {
    const result = buildTradeIntent({
      userId: "u1",
      walletAddress: "0xwallet",
      decision: enterDecision(),
      settings: baseSettings,
      existing: { status: "pending", idempotencyKey: "x" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "duplicate_intent");
  });

  it("allows retry after failed intent", () => {
    const result = buildTradeIntent({
      userId: "u1",
      walletAddress: "0xwallet",
      decision: enterDecision(),
      settings: baseSettings,
      existing: { status: "failed", idempotencyKey: "x" },
    });
    assert.equal(result.ok, true);
  });

  it("builds a pending intent for enter decisions", () => {
    const result = buildTradeIntent({
      userId: "u1",
      walletAddress: "0xwallet",
      decision: enterDecision(),
      settings: baseSettings,
      stake: 1,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.intent.status, "pending");
      assert.equal(result.intent.direction, "up");
      assert.equal(result.intent.side, "buy");
      assert.equal(result.intent.walletAddress, "0xwallet");
      assert.ok(result.intent.contracts > 0);
    }
  });
});

describe("state transitions", () => {
  it("allows pending → submitted → filled", () => {
    assert.equal(canTransition("pending", "submitted"), true);
    assert.equal(canTransition("submitted", "filled"), true);
    const t = transitionIntent("pending", "submitted");
    assert.equal(t.ok, true);
  });

  it("rejects illegal transitions", () => {
    const t = transitionIntent("failed", "filled");
    assert.equal(t.ok, false);
  });
});

describe("live submit gate", () => {
  it("blocks when ENABLE_LIVE_EXECUTION is false", () => {
    const g = assertLiveSubmitAllowed({
      enableLiveExecution: false,
      liveExecutionRequested: true,
    });
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.code, "live_execution_disabled");
  });

  it("blocks when live not requested", () => {
    const g = assertLiveSubmitAllowed({
      enableLiveExecution: true,
      liveExecutionRequested: false,
    });
    assert.equal(g.ok, false);
  });

  it("allows only when both flags true", () => {
    const g = assertLiveSubmitAllowed({
      enableLiveExecution: true,
      liveExecutionRequested: true,
    });
    assert.equal(g.ok, true);
  });

  it("plans user-wallet IOC path (not treasury)", () => {
    const built = buildTradeIntent({
      userId: "u1",
      walletAddress: "0xwallet",
      decision: enterDecision(),
      settings: baseSettings,
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const plan = planLiveSubmission(built.intent);
    assert.equal(plan.signer, "user_wallet");
    assert.equal(plan.orderType, "IOC");
    assert.ok(plan.steps.some((s) => s.includes("user privateKey")));
    assert.ok(!plan.steps.some((s) => /treasury/i.test(s) && /sign/i.test(s)));
  });
});

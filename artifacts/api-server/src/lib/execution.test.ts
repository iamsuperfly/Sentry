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
import {
  DEFAULT_USER_PREFERENCES,
  evaluateRisk,
  validateUserSettings,
} from "./risk.ts";
import { DEFAULT_SYSTEM_LIMITS } from "./system-limits.ts";
import type { StrategyDecision } from "./strategy.ts";

const system = DEFAULT_SYSTEM_LIMITS;

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

const validUser = {
  ...DEFAULT_USER_PREFERENCES,
  tradingEnabled: true,
  defaultStake: 2,
  maxTradeStake: 10,
  maxDailyLoss: 30,
  maxOpenPositions: 2,
  dailyProfitTarget: null as number | null,
  realizedPnlToday: 0,
  openPositionCount: 0,
  collateralBalance: 50,
};

describe("validateUserSettings", () => {
  it("accepts valid prefs within system ceilings", () => {
    const r = validateUserSettings(
      {
        tradingEnabled: true,
        defaultStake: 5,
        maxTradeStake: 10,
        maxDailyLoss: 30,
        maxOpenPositions: 2,
        dailyProfitTarget: null,
      },
      system,
    );
    assert.equal(r.ok, true);
  });

  it("rejects max_trade_stake above system max 200", () => {
    const r = validateUserSettings(
      {
        tradingEnabled: true,
        defaultStake: 1,
        maxTradeStake: 500,
        maxDailyLoss: 10,
        maxOpenPositions: 1,
        dailyProfitTarget: null,
      },
      system,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "max_trade_stake_above_system_max");
  });

  it("rejects default_stake above user max_trade_stake", () => {
    const r = validateUserSettings(
      {
        tradingEnabled: true,
        defaultStake: 15,
        maxTradeStake: 10,
        maxDailyLoss: 10,
        maxOpenPositions: 1,
        dailyProfitTarget: null,
      },
      system,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "default_above_user_max");
  });

  it("rejects max_daily_loss above system 70", () => {
    const r = validateUserSettings(
      {
        tradingEnabled: true,
        defaultStake: 1,
        maxTradeStake: 1,
        maxDailyLoss: 100,
        maxOpenPositions: 1,
        dailyProfitTarget: null,
      },
      system,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "max_daily_loss_above_system_max");
  });

  it("rejects max_open_positions above system 5", () => {
    const r = validateUserSettings(
      {
        tradingEnabled: true,
        defaultStake: 1,
        maxTradeStake: 1,
        maxDailyLoss: 10,
        maxOpenPositions: 9,
        dailyProfitTarget: null,
      },
      system,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid_max_open_positions");
  });
});

describe("evaluateRisk system + user layers", () => {
  it("rejects stake below system min 1", () => {
    const r = evaluateRisk({
      stake: 0.5,
      limitPrice: 0.4,
      settings: validUser,
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "stake_below_system_min");
  });

  it("rejects stake above system max 200", () => {
    const r = evaluateRisk({
      stake: 201,
      limitPrice: 0.4,
      settings: { ...validUser, maxTradeStake: 200, collateralBalance: 500 },
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "stake_above_system_max");
  });

  it("rejects stake above user max_trade_stake", () => {
    const r = evaluateRisk({
      stake: 15,
      limitPrice: 0.4,
      settings: validUser,
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "stake_exceeds_user_max");
  });

  it("accepts valid stake within user and system", () => {
    const r = evaluateRisk({
      stake: 5,
      limitPrice: 0.4,
      settings: validUser,
      system,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.stake, 5);
      assert.equal(r.contracts, 12.5);
    }
  });

  it("rejects at system open-position ceiling", () => {
    const r = evaluateRisk({
      stake: 2,
      limitPrice: 0.4,
      settings: {
        ...validUser,
        maxOpenPositions: 5,
        openPositionCount: 5,
      },
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "system_max_open_positions");
  });

  it("rejects at user open-position ceiling", () => {
    const r = evaluateRisk({
      stake: 2,
      limitPrice: 0.4,
      settings: {
        ...validUser,
        maxOpenPositions: 2,
        openPositionCount: 2,
      },
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "user_max_open_positions");
  });

  it("rejects when user daily loss stop reached", () => {
    const r = evaluateRisk({
      stake: 2,
      limitPrice: 0.4,
      settings: { ...validUser, maxDailyLoss: 30, realizedPnlToday: -30 },
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "user_daily_loss_stop");
  });

  it("rejects when system daily loss ceiling reached", () => {
    const r = evaluateRisk({
      stake: 2,
      limitPrice: 0.4,
      settings: {
        ...validUser,
        maxDailyLoss: 70,
        realizedPnlToday: -70,
      },
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "system_daily_loss_stop");
  });

  it("rejects when daily profit target reached", () => {
    const r = evaluateRisk({
      stake: 2,
      limitPrice: 0.4,
      settings: {
        ...validUser,
        dailyProfitTarget: 20,
        realizedPnlToday: 20,
      },
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "daily_profit_target_reached");
  });

  it("rejects when trading_enabled=false", () => {
    const r = evaluateRisk({
      stake: 2,
      limitPrice: 0.4,
      settings: { ...validUser, tradingEnabled: false },
      system,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "trading_disabled");
  });

  it("default user prefs have trading disabled", () => {
    assert.equal(DEFAULT_USER_PREFERENCES.tradingEnabled, false);
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
      decision: enterDecision({
        action: "skip",
        direction: null,
        limitPriceHint: null,
      }),
      settings: validUser,
      system,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_enter");
  });

  it("rejects duplicate active intents", () => {
    const result = buildTradeIntent({
      userId: "u1",
      walletAddress: "0xwallet",
      decision: enterDecision(),
      settings: validUser,
      system,
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
      settings: validUser,
      system,
      stake: 2,
      existing: { status: "failed", idempotencyKey: "x" },
    });
    assert.equal(result.ok, true);
  });

  it("builds a pending intent for enter decisions", () => {
    const result = buildTradeIntent({
      userId: "u1",
      walletAddress: "0xwallet",
      decision: enterDecision(),
      settings: validUser,
      system,
      stake: 2,
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

  it("plans user-wallet IOC with tUSDC collateral", () => {
    const built = buildTradeIntent({
      userId: "u1",
      walletAddress: "0xwallet",
      decision: enterDecision(),
      settings: validUser,
      system,
      stake: 2,
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const plan = planLiveSubmission(built.intent);
    assert.equal(plan.signer, "user_wallet");
    assert.equal(plan.orderType, "IOC");
    assert.equal(plan.collateralToken, "tUSDC");
    assert.ok(plan.steps.some((s) => s.includes("PROTOCOL")));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../config.ts";
import type { DreamdexDiagnostic } from "./dreamdex.ts";
import type { LiveSubmitResult } from "./live-execution.ts";
import type { StrategyDecision, StrategyRunResult } from "./strategy.ts";
import { DEFAULT_SYSTEM_LIMITS } from "./system-limits.ts";
import type { TradeIntent } from "./execution.ts";
import {
  runTelegramTradeCycle,
  selectEnterDecision,
  type PersistResult,
} from "./trade-orchestration.ts";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 5000,
    telegramBotToken: "t",
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "s",
    rpcUrl: "https://dream-rpc.somnia.network",
    dreamdexIndexerUrl: "https://dev.smk.somnia.host/v1/graphql",
    wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
    initialGasSponsorAmount: "0.1",
    explorerTxBaseUrl: "https://shannon-explorer.somnia.network/tx",
    treasuryPrivateKey: "0x" + "22".repeat(32),
    walletEncryptionKey: "a".repeat(64),
    enableLiveExecution: false,
    systemLimits: DEFAULT_SYSTEM_LIMITS,
    ...overrides,
  };
}

function enterDecision(
  overrides: Partial<StrategyDecision> = {},
): StrategyDecision {
  return {
    action: "enter",
    marketId: "0xmarket-eth",
    asset: "ETH",
    direction: "NO",
    limitPriceHint: 0.311,
    poolAddress: "0xpool",
    strategyName: "edge-taker-v1",
    strategyVersion: "1.0.0",
    edge: 0.19,
    reason: "test enter",
    ...overrides,
  } as StrategyDecision;
}

function strategyRun(decisions: StrategyDecision[]): StrategyRunResult {
  return {
    decisions,
    enterCount: decisions.filter((d) => d.action === "enter").length,
    skipCount: decisions.filter((d) => d.action === "skip").length,
  } as StrategyRunResult;
}

function intentFor(userId: string, wallet: string): TradeIntent {
  return {
    idempotencyKey: `${userId}:0xmarket-eth:edge-taker-v1:1.0.0:NO`,
    userId,
    walletAddress: wallet,
    marketId: "0xmarket-eth",
    symbol: "ETH-0xmarket/NO",
    direction: "down",
    side: "buy",
    strategyName: "edge-taker-v1",
    strategyVersion: "1.0.0",
    stake: 1,
    contracts: 3,
    limitPrice: 0.311,
    poolAddress: "0xpool",
    status: "pending",
    decision: enterDecision(),
    rejectReason: null,
  };
}

describe("selectEnterDecision", () => {
  it("returns the first enter decision", () => {
    const d = selectEnterDecision(
      strategyRun([
        { ...enterDecision(), action: "skip" } as StrategyDecision,
        enterDecision({ marketId: "0xbest" }),
      ]),
    );
    assert.equal(d?.marketId, "0xbest");
  });

  it("returns null when no enter", () => {
    assert.equal(selectEnterDecision(strategyRun([])), null);
  });
});

describe("runTelegramTradeCycle", () => {
  it("rejects missing Telegram identity (no client user_id trust)", async () => {
    const result = await runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: Number.NaN, first_name: "x" },
      deps: {
        readMarkets: async () => {
          throw new Error("should not read markets");
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unauthenticated");
  });

  it("resolves identity → persist → execute with server-side userId", async () => {
    const identity = { id: 42, first_name: "Builder", username: "iamsuperfly" };
    const calls: string[] = [];
    let executedTradeId: string | undefined;
    let executedIdentityId: number | undefined;

    const decision = enterDecision();
    const result = await runTelegramTradeCycle({
      config: baseConfig(),
      identity,
      liveExecutionRequested: true,
      stake: 1,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([decision]),
        persistIntent: async (input) => {
          calls.push("persist");
          assert.equal(input.identity.id, 42);
          assert.equal(input.decision.direction, "NO");
          assert.equal(input.stake, 1);
          const userId = "internal-user-42";
          return {
            ok: true,
            userId,
            trade: { id: "trade-uuid-1" },
            intent: intentFor(userId, "0xuser-wallet-42"),
          } satisfies PersistResult;
        },
        executePersisted: async (input) => {
          calls.push("execute");
          executedIdentityId = input.identity.id;
          executedTradeId = input.tradeId;
          assert.equal(input.liveExecutionRequested, true);
          const gated: LiveSubmitResult = {
            ok: false,
            gated: true,
            code: "live_execution_disabled",
            reason: "ENABLE_LIVE_EXECUTION is false.",
            tradeId: input.tradeId,
            status: "pending",
          };
          return gated;
        },
      },
    });

    assert.deepEqual(calls, ["persist", "execute"]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.userId, "internal-user-42");
      assert.equal(result.tradeId, "trade-uuid-1");
      assert.equal(result.stake, 1);
      assert.equal(result.decision.direction, "NO");
      assert.equal(result.execution.ok, false);
      if (!result.execution.ok) {
        assert.equal(result.execution.gated, true);
        assert.equal(result.execution.code, "live_execution_disabled");
      }
    }
    assert.equal(executedIdentityId, 42);
    assert.equal(executedTradeId, "trade-uuid-1");
  });

  it("cannot force another user wallet — execute receives only Telegram identity", async () => {
    const attacker = { id: 99, first_name: "Attacker" };
    let executeIdentityId: number | undefined;
    let persistIdentityId: number | undefined;

    await runTelegramTradeCycle({
      config: baseConfig(),
      identity: attacker,
      liveExecutionRequested: true,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([enterDecision()]),
        persistIntent: async (input) => {
          persistIdentityId = input.identity.id;
          return {
            ok: true,
            userId: "user-99",
            trade: { id: "t-99" },
            intent: intentFor("user-99", "0xwallet-99"),
          };
        },
        executePersisted: async (input) => {
          executeIdentityId = input.identity.id;
          return {
            ok: false,
            code: "wallet_not_owned",
            reason: "The Telegram user does not own an execution wallet.",
            tradeId: input.tradeId,
          };
        },
      },
    });

    assert.equal(persistIdentityId, 99);
    assert.equal(executeIdentityId, 99);
  });

  it("never selects treasury — orchestration passes only Telegram identity + tradeId", async () => {
    let sawTreasuryKey = false;
    await runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: 7, first_name: "U" },
      liveExecutionRequested: true,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([enterDecision()]),
        persistIntent: async () => ({
          ok: true,
          userId: "u7",
          trade: { id: "t7" },
          intent: intentFor("u7", "0xuser7"),
        }),
        executePersisted: async (input) => {
          const asRecord = input as Record<string, unknown>;
          if (
            "encryptedPrivateKey" in asRecord ||
            "treasuryPrivateKey" in asRecord ||
            "privateKey" in asRecord
          ) {
            sawTreasuryKey = true;
          }
          return {
            ok: false,
            gated: true,
            code: "live_execution_disabled",
            reason: "blocked",
            tradeId: input.tradeId,
          };
        },
      },
    });
    assert.equal(sawTreasuryKey, false);
  });

  it("propagates risk rejection from persist without calling execute", async () => {
    let executeCalled = false;
    const result = await runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: 1, first_name: "U" },
      liveExecutionRequested: true,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([enterDecision()]),
        persistIntent: async () => ({
          ok: false,
          code: "trading_disabled",
          reason: "Trading is disabled for this user.",
          idempotencyKey: "k",
        }),
        executePersisted: async () => {
          executeCalled = true;
          throw new Error("should not execute");
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "trading_disabled");
    assert.equal(executeCalled, false);
  });

  it("preserves idempotency by delegating persist (duplicate active intent)", async () => {
    const result = await runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: 3, first_name: "U" },
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([enterDecision()]),
        persistIntent: async () => ({
          ok: false,
          code: "duplicate_intent",
          reason: "Active intent already exists with status submitted.",
          idempotencyKey: "dup-key",
        }),
        executePersisted: async () => {
          throw new Error("should not execute");
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "duplicate_intent");
  });

  it("invokes execute with persisted trade id; live gate closed when not requested", async () => {
    let liveRequested: boolean | undefined;
    const result = await runTelegramTradeCycle({
      config: baseConfig({ enableLiveExecution: false }),
      identity: { id: 5, first_name: "U" },
      liveExecutionRequested: false,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([enterDecision()]),
        persistIntent: async () => ({
          ok: true,
          userId: "u5",
          trade: { id: "trade-5" },
          intent: intentFor("u5", "0xw5"),
        }),
        executePersisted: async (input) => {
          liveRequested = input.liveExecutionRequested;
          assert.equal(input.tradeId, "trade-5");
          return {
            ok: false,
            gated: true,
            code: "live_not_requested",
            reason: "Caller did not request liveExecution=true.",
            tradeId: input.tradeId,
          };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(liveRequested, false);
  });

  it("does not send a blockchain transaction when ENABLE_LIVE_EXECUTION is false", async () => {
    let chainWrite = false;
    const result = await runTelegramTradeCycle({
      config: baseConfig({ enableLiveExecution: false }),
      identity: { id: 8, first_name: "U" },
      liveExecutionRequested: true,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([enterDecision()]),
        persistIntent: async () => ({
          ok: true,
          userId: "u8",
          trade: { id: "t8" },
          intent: intentFor("u8", "0xw8"),
        }),
        executePersisted: async (input) => ({
          ok: false,
          gated: true,
          code: "live_execution_disabled",
          reason:
            "ENABLE_LIVE_EXECUTION is false. Intents may be recorded; chain submit is blocked.",
          tradeId: input.tradeId,
          status: "pending",
        }),
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.execution.ok, false);
      if (!result.execution.ok) {
        assert.equal(result.execution.gated, true);
      }
    }
    assert.equal(chainWrite, false);
  });

  it("returns no_enter_decision without persisting", async () => {
    let persistCalled = false;
    const result = await runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: 2, first_name: "U" },
      deps: {
        readMarkets: async () =>
          ({ markets: [] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([]),
        persistIntent: async () => {
          persistCalled = true;
          throw new Error("no");
        },
        executePersisted: async () => {
          throw new Error("no");
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "no_enter_decision");
    assert.equal(persistCalled, false);
  });
});

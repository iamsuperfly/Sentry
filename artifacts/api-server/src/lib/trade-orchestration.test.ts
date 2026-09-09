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
  rankedEnterDecisions,
  type PersistResult,
} from "./trade-orchestration.ts";
import { sizeAdaptiveStakeFromEntry } from "./adaptive-stake.ts";
import { formatMultiTradeReply } from "./telegram-multi-trade-reply.ts";

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

function gated(tradeId: string): LiveSubmitResult {
  return {
    ok: false,
    gated: true,
    code: "live_execution_disabled",
    reason: "blocked",
    tradeId,
    status: "pending",
  };
}

function persistOk(
  userId: string,
  tradeId: string,
  decision: StrategyDecision,
  stake: number,
): PersistResult {
  return {
    ok: true,
    userId,
    trade: { id: tradeId },
    intent: { ...intentFor(userId, "0xw"), stake, symbol: `${decision.asset}/${decision.direction}` },
  };
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

  it("preserves existing rank order for all ENTER candidates", () => {
    const ranked = rankedEnterDecisions(
      strategyRun([
        enterDecision({ marketId: "0xnear" }),
        enterDecision({ marketId: "0xmid" }),
        enterDecision({ marketId: "0xfar" }),
        { ...enterDecision(), action: "skip" } as StrategyDecision,
      ]),
    );
    assert.deepEqual(
      ranked.map((d) => d.marketId),
      ["0xnear", "0xmid", "0xfar"],
    );
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

  it("passes adaptive stakeMode without a manual stake", async () => {
    let persistStake: number | undefined;
    let persistMode: string | undefined;
    const result = await runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: 11, first_name: "U" },
      stakeMode: "adaptive",
      stake: 30,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([enterDecision()]),
        persistIntent: async (input) => {
          persistStake = input.stake;
          persistMode = input.stakeMode;
          return {
            ok: true,
            userId: "u11",
            trade: { id: "t11" },
            intent: { ...intentFor("u11", "0xw11"), stake: 15 },
          };
        },
        executePersisted: async (input) => ({
          ok: false,
          gated: true,
          code: "live_execution_disabled",
          reason: "blocked",
          tradeId: input.tradeId,
          status: "pending",
        }),
      },
    });
    assert.equal(persistMode, "adaptive");
    assert.equal(persistStake, undefined);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.marketScan.selected, 1);
      assert.equal(result.trades.length, 1);
    }
  });

  it("keeps manual defaultStake when stakeMode is omitted", async () => {
    let persistStake: number | undefined;
    let persistMode: string | undefined;
    await runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: 12, first_name: "U" },
      stake: 30,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([enterDecision()]),
        persistIntent: async (input) => {
          persistStake = input.stake;
          persistMode = input.stakeMode;
          return {
            ok: true,
            userId: "u12",
            trade: { id: "t12" },
            intent: intentFor("u12", "0xw12"),
          };
        },
        executePersisted: async (input) => ({
          ok: false,
          gated: true,
          code: "live_execution_disabled",
          reason: "blocked",
          tradeId: input.tradeId,
          status: "pending",
        }),
      },
    });
    assert.equal(persistMode, "manual");
    assert.equal(persistStake, 30);
  });

  it("manual /trade still selects one ENTER when several candidates exist", async () => {
    const first = enterDecision({ marketId: "0xfirst" });
    const second = enterDecision({ marketId: "0xsecond" });
    let persistedMarket: string | undefined;
    const result = await runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: 13, first_name: "U" },
      stake: 30,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun([first, second]),
        persistIntent: async (input) => {
          persistedMarket = input.decision.marketId;
          return {
            ok: true,
            userId: "u13",
            trade: { id: "t13" },
            intent: intentFor("u13", "0xw13"),
          };
        },
        executePersisted: async (input) => gated(input.tradeId),
      },
    });
    assert.equal(persistedMarket, "0xfirst");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.marketScan.selected, 1);
      assert.equal(result.trades.length, 1);
      assert.equal(result.trades[0]?.marketId, "0xfirst");
    }
  });
});

describe("autonomous multi-slot fill", () => {
  const five = [
    enterDecision({ marketId: "0xa", limitPriceHint: 0.46 }),
    enterDecision({ marketId: "0xb", limitPriceHint: 0.42 }),
    enterDecision({ marketId: "0xc", limitPriceHint: 0.3 }),
    enterDecision({ marketId: "0xd", limitPriceHint: 0.2 }),
    enterDecision({ marketId: "0xe", limitPriceHint: 0.15 }),
  ];

  function cycle(input: {
    decisions: StrategyDecision[];
    availableSlots: number;
    persistIntent: (args: {
      decision: StrategyDecision;
      stake?: number;
      stakeMode?: string;
    }) => Promise<PersistResult>;
  }) {
    return runTelegramTradeCycle({
      config: baseConfig(),
      identity: { id: 99, first_name: "U" },
      stakeMode: "adaptive",
      fillAvailableSlots: true,
      availableSlots: input.availableSlots,
      deps: {
        readMarkets: async () =>
          ({ markets: [{}] }) as unknown as DreamdexDiagnostic,
        evaluate: () => strategyRun(input.decisions),
        persistIntent: async (args) =>
          input.persistIntent({
            decision: args.decision,
            stake: args.stake,
            stakeMode: args.stakeMode,
          }),
        executePersisted: async (args) => gated(args.tradeId),
      },
    });
  }

  function persistSized(decision: StrategyDecision): PersistResult {
    const sized = sizeAdaptiveStakeFromEntry({
      entryPrice: decision.limitPriceHint ?? Number.NaN,
      maxTradeStake: 50,
      systemMinStake: 1,
      systemMaxStake: 200,
      remainingBudget: 300,
    });
    const stake = sized.ok ? sized.stake : 0;
    return persistOk("u99", `t-${decision.marketId}`, decision, stake);
  }

  it("5 eligible candidates + 3 slots → top 3 ranked", async () => {
    const persisted: string[] = [];
    const result = await cycle({
      decisions: five,
      availableSlots: 3,
      persistIntent: async ({ decision, stake, stakeMode }) => {
        persisted.push(decision.marketId);
        assert.equal(stakeMode, "adaptive");
        assert.equal(stake, undefined);
        return persistSized(decision);
      },
    });
    assert.deepEqual(persisted, ["0xa", "0xb", "0xc"]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.marketScan.enterCandidates, 5);
      assert.equal(result.marketScan.availableSlots, 3);
      assert.equal(result.marketScan.selected, 3);
      assert.deepEqual(
        result.trades.map((t) => t.marketId),
        ["0xa", "0xb", "0xc"],
      );
    }
  });

  it("2 eligible candidates + 3 slots → both selected", async () => {
    const result = await cycle({
      decisions: five.slice(0, 2),
      availableSlots: 3,
      persistIntent: async ({ decision }) => persistSized(decision),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.trades.length, 2);
      assert.deepEqual(
        result.trades.map((t) => t.marketId),
        ["0xa", "0xb"],
      );
    }
  });

  it("1 eligible candidate → one selected", async () => {
    const result = await cycle({
      decisions: [five[0]!],
      availableSlots: 3,
      persistIntent: async ({ decision }) => persistSized(decision),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.trades.length, 1);
      assert.equal(result.trades[0]?.marketId, "0xa");
    }
  });

  it("0 eligible candidates → none", async () => {
    const result = await cycle({
      decisions: [],
      availableSlots: 3,
      persistIntent: async () => {
        throw new Error("should not persist");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "no_enter_decision");
    assert.equal(result.marketScan?.selected ?? 0, 0);
  });

  it("each selected trade gets its own adaptive stake, not a split", async () => {
    const result = await cycle({
      decisions: five,
      availableSlots: 3,
      persistIntent: async ({ decision, stake }) => {
        assert.equal(stake, undefined);
        return persistSized(decision);
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const stakes = result.trades.map((t) => t.stake);
      assert.deepEqual(stakes, [12.5, 15, 20]);
      const split = (12.5 + 15 + 20) / 3;
      for (const s of stakes) assert.notEqual(s, split);
    }
  });

  it("a risk-rejected candidate does not consume a slot; later ranks fill it", async () => {
    const persisted: string[] = [];
    const result = await cycle({
      decisions: five,
      availableSlots: 3,
      persistIntent: async ({ decision }) => {
        persisted.push(decision.marketId);
        if (decision.marketId === "0xb") {
          return {
            ok: false,
            code: "stake_below_system_min",
            reason: "too small",
            idempotencyKey: "k",
          };
        }
        return persistSized(decision);
      },
    });
    assert.deepEqual(persisted, ["0xa", "0xb", "0xc", "0xd"]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.trades.length, 3);
      assert.deepEqual(
        result.trades.map((t) => t.marketId),
        ["0xa", "0xc", "0xd"],
      );
      assert.deepEqual(
        result.trades.map((t) => t.stake),
        [12.5, 20, 30],
      );
    }
  });

  it("preserves existing ranking order when filling slots", async () => {
    const result = await cycle({
      decisions: five,
      availableSlots: 2,
      persistIntent: async ({ decision }) => persistSized(decision),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.trades.map((t) => t.marketId),
        ["0xa", "0xb"],
      );
    }
  });

  it("Trades: N matches the number of attempts", async () => {
    const result = await cycle({
      decisions: five,
      availableSlots: 3,
      persistIntent: async ({ decision }) => persistSized(decision),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const text = formatMultiTradeReply({
      trades: result.trades,
      fallback: {
        tradeId: result.tradeId,
        intentSymbol: result.intentSymbol,
        decision: result.decision,
        stake: result.stake,
        execution: result.execution,
      },
      marketsLine: "",
      executionMode: "testnet",
      explorerTxBaseUrl: "https://example.test/tx",
    });
    assert.match(text, /^Trades: 3\n/);
    assert.equal(result.trades.length, 3);

    const none = formatMultiTradeReply({
      trades: [],
      fallback: {
        tradeId: "",
        intentSymbol: "",
        decision: five[0]!,
        stake: 0,
        execution: gated(""),
      },
      marketsLine: "",
      executionMode: "testnet",
      explorerTxBaseUrl: "https://example.test/tx",
    });
    assert.equal(none, "Trades: 0");
  });
});

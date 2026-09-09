/**
 * Production execution wiring (Stage 6 entry boundary).
 *
 * Production: 1m Binance vote (left >= 30) then 5m/15m+ edge-taker-v1
 * → risk → persist → execute.
 * Unit tests may inject `evaluate` to skip live 1m/edge-taker.
 */

import type { AppConfig } from "../config.ts";
import type { DreamdexDiagnostic } from "./dreamdex.ts";
import { attachMarketWindowMeta } from "./decision-market-meta.ts";
import type { LiveSubmitResult } from "./live-execution.ts";
import type { StrategyDecision, StrategyRunResult } from "./strategy.ts";
import { summarizeMarketIntelligence } from "./market-intelligence.ts";
import { logger } from "./logger.ts";
import {
  evaluateOneMinMarketWithBinance,
  marketEligibleForOneMin,
  oneMinEnterToStrategyDecision,
} from "./one-min-runtime.ts";
import type { TelegramIdentity } from "./trade-persistence.ts";
import type { CandidateTradeAttempt } from "./multi-ai-execution.ts";

export const ORCHESTRATION_MODULE = "stage-6-execution-wiring";

export type PersistResult =
  | {
      ok: true;
      userId: string;
      trade: unknown;
      intent: {
        symbol: string;
        stake: number;
        userId: string;
        walletAddress: string;
      };
    }
  | { ok: false; code: string; reason: string; idempotencyKey: string };

export type TradeOrchestrationDeps = {
  readMarkets: (
    config: AppConfig,
    asset?: string,
  ) => Promise<DreamdexDiagnostic>;
  evaluate: (markets: DreamdexDiagnostic["markets"]) => StrategyRunResult;
  expireStalePending?: (input: {
    config: AppConfig;
    identity: TelegramIdentity;
    markets: DreamdexDiagnostic["markets"];
  }) => Promise<string[]>;
  persistIntent: (input: {
    config: AppConfig;
    identity: TelegramIdentity;
    decision: StrategyDecision;
    stake?: number;
    stakeMode?: "manual" | "adaptive";
  }) => Promise<PersistResult>;
  executePersisted: (input: {
    config: AppConfig;
    identity: TelegramIdentity;
    tradeId: string;
    liveExecutionRequested: boolean;
  }) => Promise<LiveSubmitResult>;
};

export async function loadDefaultTradeOrchestrationDeps(): Promise<TradeOrchestrationDeps> {
  const [
    { readDreamdexMarkets },
    { evaluateMarkets },
    {
      createPersistedTradeIntent,
      expireStalePendingTradeIntentsForTelegram,
    },
    { readPendingMarketState },
    { executePersistedTradeForTelegram },
  ] = await Promise.all([
    import("./dreamdex.ts"),
    import("./strategy.ts"),
    import("./trade-persistence.ts"),
    import("./live-execution-adapter.ts"),
    import("./trade-execution.ts"),
  ]);
  return {
    readMarkets: readDreamdexMarkets,
    evaluate: evaluateMarkets,
    expireStalePending: ({ config, identity, markets }) =>
      expireStalePendingTradeIntentsForTelegram(
        config,
        identity,
        markets,
        (marketId) => readPendingMarketState(config, marketId),
      ),
    persistIntent:
      createPersistedTradeIntent as TradeOrchestrationDeps["persistIntent"],
    executePersisted: executePersistedTradeForTelegram,
  };
}

export type MarketScanSummary = {
  discovered: number;
  supported: number;
  tradable: number;
  enterCandidates: number;
  withUsableAsks?: number;
  btc?: number;
  eth?: number;
  byDuration?: Record<string, number>;
  aiConfigured?: boolean;
  aiCandidates?: number;
  availableSlots?: number;
  selected?: number;
  listingApi?: string;
};

export type { CandidateTradeAttempt } from "./multi-ai-execution.ts";

export type OrchestrationSuccess = {
  ok: true;
  userId: string;
  tradeId: string;
  decision: StrategyDecision;
  intentSymbol: string;
  stake: number;
  execution: LiveSubmitResult;
  marketScan: MarketScanSummary;
  trades: CandidateTradeAttempt[];
};

export type OrchestrationFailure = {
  ok: false;
  code: string;
  reason: string;
  userId?: string;
  tradeId?: string;
  decision?: StrategyDecision;
  marketScan?: MarketScanSummary;
};

export type OrchestrationResult = OrchestrationSuccess | OrchestrationFailure;

function tradeIdFromPersisted(trade: unknown): string | null {
  if (!trade || typeof trade !== "object") return null;
  const id = (trade as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function selectEnterDecision(
  run: StrategyRunResult,
): StrategyDecision | null {
  const enters = run.decisions.filter((d) => d.action === "enter");
  if (enters.length === 0) return null;
  return enters[0] ?? null;
}

export async function runTelegramTradeCycle(input: {
  config: AppConfig;
  identity: TelegramIdentity;
  liveExecutionRequested?: boolean;
  stake?: number;
  stakeMode?: "manual" | "adaptive";
  asset?: string;
  excludeMarketIds?: string[];
  deps?: Partial<TradeOrchestrationDeps> | TradeOrchestrationDeps;
}): Promise<OrchestrationResult> {
  if (!input.identity?.id || !Number.isFinite(input.identity.id)) {
    return {
      ok: false,
      code: "unauthenticated",
      reason:
        "Telegram identity is required; client-supplied user ids are ignored.",
    };
  }

  const provided = input.deps ?? {};
  const needsDefaults =
    !provided.readMarkets ||
    !provided.persistIntent ||
    !provided.executePersisted;
  const defaults = needsDefaults
    ? await loadDefaultTradeOrchestrationDeps()
    : null;
  const deps: TradeOrchestrationDeps = {
    readMarkets: provided.readMarkets ?? defaults!.readMarkets,
    evaluate:
      provided.evaluate ??
      defaults?.evaluate ??
      ((markets) => ({
        strategyName: "none",
        strategyVersion: "0",
        evaluatedAt: new Date().toISOString(),
        config: {
          edgeThreshold: 0,
          minSecondsToExpiry: 0,
          maxSpread: 1,
          supportedAssets: ["BTC", "ETH"],
        },
        decisions: [],
        enterCount: 0,
        skipCount: markets.length,
      })),
    persistIntent: provided.persistIntent ?? defaults!.persistIntent,
    executePersisted: provided.executePersisted ?? defaults!.executePersisted,
    expireStalePending:
      provided.expireStalePending ?? defaults?.expireStalePending,
  };
  const useInjectedStrategy = Boolean(provided.evaluate);

  let snapshot: DreamdexDiagnostic;
  try {
    snapshot = await deps.readMarkets(input.config, input.asset);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 200)
        : "Market read failed.";
    return {
      ok: false,
      code: "markets_unavailable",
      reason: message,
    };
  }

  if (input.excludeMarketIds && input.excludeMarketIds.length > 0) {
    const skip = new Set(input.excludeMarketIds);
    snapshot = {
      ...snapshot,
      markets: snapshot.markets.filter((m) => !skip.has(m.marketId)),
    };
  }

  const intel = summarizeMarketIntelligence(
    snapshot.markets.map((m) => ({
      marketId: m.marketId,
      asset: m.asset,
      tradable: m.tradable,
      finalized: m.finalized,
      intervalSec: m.intervalSec,
      tradingStart: m.tradingStart,
      expiry: m.expiry,
      decimals: m.decimals,
      book: m.book,
    })),
  );

  let decision: StrategyDecision;
  let resolvedStake = input.stake;
  const marketScan: MarketScanSummary = {
    discovered: snapshot.discoveredCount,
    supported: snapshot.supportedCount,
    tradable: snapshot.tradableCount,
    enterCandidates: 0,
    withUsableAsks: intel.withUsableAsks,
    btc: intel.btc,
    eth: intel.eth,
    byDuration: intel.byDuration,
    listingApi: snapshot.listingApi,
    aiConfigured: false,
    aiCandidates: 0,
    selected: 0,
  };

  if (useInjectedStrategy) {
    const strategy = deps.evaluate(snapshot.markets);
    marketScan.enterCandidates = strategy.enterCount;
    marketScan.aiConfigured = false;
    const selected = selectEnterDecision(strategy);
    if (!selected) {
      return {
        ok: false,
        code: "no_enter_decision",
        reason:
          "No market currently meets the entry conditions (edge, liquidity, time left).",
        marketScan,
      };
    }
    marketScan.selected = 1;
    decision = attachMarketWindowMeta(selected, snapshot.markets);
  } else {
    const nowSec = Math.floor(Date.now() / 1000);
    const oneMinEnters: StrategyDecision[] = [];
    const oneMinCandidates = snapshot.markets
      .filter((m) => marketEligibleForOneMin(m, nowSec))
      .sort((a, b) => a.marketId.localeCompare(b.marketId));

    for (const m of oneMinCandidates) {
      try {
        const { decision: oneMin, prices } = await evaluateOneMinMarketWithBinance({
          market: m,
          nowSec,
        });
        logger.info(
          {
            strategy: "one-min-binance-vote-v1",
            marketId: m.marketId,
            asset: m.asset,
            prints: prices.slice(-5),
            action: oneMin.action,
            direction: oneMin.action === "enter" ? oneMin.direction : undefined,
            code: oneMin.action === "skip" ? oneMin.code : undefined,
            reason: oneMin.reason.slice(0, 160),
          },
          "1m strategy evaluation",
        );
        if (oneMin.action === "enter") {
          const mapped = oneMinEnterToStrategyDecision({
            market: m,
            oneMin,
            nowSec,
          });
          if (mapped) oneMinEnters.push(mapped);
        }
      } catch (err) {
        logger.warn(
          {
            marketId: m.marketId,
            err: err instanceof Error ? err.message.slice(0, 120) : "1m error",
          },
          "1m strategy error",
        );
      }
    }

    oneMinEnters.sort((a, b) => {
      const leftA = a.secondsToExpiry ?? Number.POSITIVE_INFINITY;
      const leftB = b.secondsToExpiry ?? Number.POSITIVE_INFINITY;
      if (leftA !== leftB) return leftA - leftB;
      return a.marketId.localeCompare(b.marketId);
    });

    if (oneMinEnters[0]) {
      marketScan.enterCandidates = oneMinEnters.length;
      marketScan.selected = 1;
      marketScan.aiConfigured = false;
      decision = attachMarketWindowMeta(oneMinEnters[0], snapshot.markets);
    } else {
      const strategy = deps.evaluate(snapshot.markets);
      marketScan.enterCandidates = strategy.enterCount;
      marketScan.aiConfigured = false;
      const selected = selectEnterDecision(strategy);
      if (!selected) {
        return {
          ok: false,
          code: "no_enter_decision",
          reason:
            "No market currently meets the entry conditions (edge, liquidity, time left).",
          marketScan,
        };
      }
      marketScan.selected = 1;
      decision = attachMarketWindowMeta(selected, snapshot.markets);
    }
  }

  if (deps.expireStalePending) {
    try {
      await deps.expireStalePending({
        config: input.config,
        identity: input.identity,
        markets: snapshot.markets,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 200)
          : "Unable to expire stale trade intents.";
      return {
        ok: false,
        code: "stale_intent_cleanup_failed",
        reason: message,
        decision,
      };
    }
  }

  let persisted: PersistResult;
  try {
    persisted = await deps.persistIntent({
      config: input.config,
      identity: input.identity,
      decision,
      stake: input.stakeMode === "adaptive" ? undefined : resolvedStake,
      stakeMode: input.stakeMode ?? "manual",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 200)
        : "Unable to persist trade intent.";
    return {
      ok: false,
      code: "persist_failed",
      reason: message,
      decision,
    };
  }

  if (!persisted.ok) {
    return {
      ok: false,
      code: persisted.code,
      reason: persisted.reason,
      decision,
    };
  }

  const tradeId = tradeIdFromPersisted(persisted.trade);
  if (!tradeId) {
    return {
      ok: false,
      code: "missing_trade_id",
      reason: "Persisted trade row did not include an id.",
      userId: persisted.userId,
      decision,
    };
  }

  const execution = await deps.executePersisted({
    config: input.config,
    identity: input.identity,
    tradeId,
    liveExecutionRequested: input.liveExecutionRequested === true,
  });

  const singleAttempt: CandidateTradeAttempt = {
    marketId: decision.marketId,
    asset: decision.asset,
    direction: String(decision.direction),
    stake: persisted.intent.stake,
    limitPriceHint: decision.limitPriceHint,
    tradeId,
    intentSymbol: persisted.intent.symbol,
    decision,
    execution,
    ok: execution.ok,
    code: execution.ok ? undefined : execution.code,
    reasonDetail: execution.ok ? undefined : execution.reason,
  };

  return {
    ok: true,
    userId: persisted.userId,
    tradeId,
    decision,
    intentSymbol: persisted.intent.symbol,
    stake: persisted.intent.stake,
    execution,
    marketScan,
    trades: [singleAttempt],
  };
}

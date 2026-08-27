/**
 * Production execution wiring (Stage 6 entry boundary).
 *
 * Telegram identity → server-side user_id + wallet → Stage 2 decision →
 * persisted trade intent → executePersistedTradeForTelegram.
 *
 * Does not trust client-supplied user_id or wallet addresses.
 * Does not place orders itself — delegates to existing Stage 5 path.
 *
 * Production decision path (15m+): Gemini → validate → risk → persist → execute.
 * Unit tests may inject `evaluate` to exercise the legacy edge-taker path.
 */

import type { AppConfig } from "../config.ts";
import type { DreamdexDiagnostic } from "./dreamdex.ts";
import { attachMarketWindowMeta } from "./decision-market-meta.ts";
import type { LiveSubmitResult } from "./live-execution.ts";
import type { StrategyDecision, StrategyRunResult } from "./strategy.ts";
import { summarizeMarketIntelligence } from "./market-intelligence.ts";
import {
  callGeminiMarketDecisions,
  isGeminiConfigured,
} from "./gemini-client.ts";
import { validateAiCandidates } from "./ai-decision-validate.ts";
import {
  geminiCandidateToStrategyDecision,
  marketEligibleForGemini,
  toGeminiMarketInput,
} from "./gemini-path.ts";
import { secondsToExpiry } from "./strategy.ts";
import { logger } from "./logger.ts";
import type { TelegramIdentity } from "./trade-persistence.ts";

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

export type OrchestrationSuccess = {
  ok: true;
  userId: string;
  tradeId: string;
  decision: StrategyDecision;
  intentSymbol: string;
  stake: number;
  execution: LiveSubmitResult;
  marketScan: MarketScanSummary;
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
  asset?: string;
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
    const geminiEligible = snapshot.markets.filter((m) =>
      marketEligibleForGemini(m, nowSec),
    );
    const geminiConfigured = isGeminiConfigured({
      apiKey: input.config.geminiApiKey,
    });
    marketScan.aiConfigured = geminiConfigured;

    if (!geminiConfigured) {
      logger.info(
        { provider: "gemini", marketsEligible: geminiEligible.length },
        "AI not configured — GEMINI_API_KEY missing",
      );
      return {
        ok: false,
        code: "ai_not_configured",
        reason:
          "AI not configured. Set GEMINI_API_KEY (and optional GEMINI_MODEL) on the server.",
        marketScan,
      };
    }

    if (geminiEligible.length === 0) {
      return {
        ok: false,
        code: "no_enter_decision",
        reason:
          "No 15m+ tradable markets with usable asks in this scan for Gemini.",
        marketScan,
      };
    }

    const availableSlots = Math.max(
      1,
      Math.min(input.config.systemLimits.maxOpenPositions, 3),
    );
    marketScan.availableSlots = availableSlots;

    const geminiInputs = geminiEligible.map((m) =>
      toGeminiMarketInput(m, nowSec),
    );
    const geminiResult = await callGeminiMarketDecisions({
      apiKey: input.config.geminiApiKey!,
      model: input.config.geminiModel,
      markets: geminiInputs,
      availableSlots,
    });

    if (!geminiResult.ok) {
      logger.warn(
        {
          provider: "gemini",
          model: geminiResult.audit.model,
          code: geminiResult.code,
          latencyMs: geminiResult.audit.latencyMs,
          marketsSupplied: geminiResult.audit.marketsSupplied,
        },
        "AI request failed",
      );
      return {
        ok: false,
        code: geminiResult.code,
        reason: geminiResult.reason,
        marketScan,
      };
    }

    logger.info(
      {
        provider: "gemini",
        model: geminiResult.audit.model,
        latencyMs: geminiResult.audit.latencyMs,
        marketsSupplied: geminiResult.audit.marketsSupplied,
        decisionsReturned: geminiResult.audit.decisionsReturned,
        snapshotHash: geminiResult.audit.snapshotHash,
      },
      "AI decisions received",
    );

    const validation = validateAiCandidates(
      geminiResult.decisions.map((d) => ({
        marketId: d.marketId,
        direction: d.direction,
        confidence: d.confidence,
        reason: d.reason,
        stake: d.stake,
      })),
      {
        markets: geminiEligible.map((m) => ({
          marketId: m.marketId,
          tradable: m.tradable,
          finalized: m.finalized,
          secondsToExpiry: secondsToExpiry(m.expiry, nowSec),
          asset: m.asset,
        })),
        availableSlots,
        systemMinStake: input.config.systemLimits.minStake,
        systemMaxStake: input.config.systemLimits.maxStake,
        userMaxStake: input.config.systemLimits.maxStake,
        defaultStake: input.stake ?? input.config.systemLimits.minStake,
      },
    );

    marketScan.aiCandidates = geminiResult.decisions.length;
    marketScan.enterCandidates = validation.accepted.length;

    logger.info(
      {
        provider: "gemini",
        accepted: validation.accepted.length,
        rejected: validation.rejected.length,
        rejectedCodes: validation.rejected.map((r) => r.code),
      },
      "AI deterministic validation complete",
    );

    if (validation.accepted.length === 0) {
      return {
        ok: false,
        code: "no_enter_decision",
        reason:
          validation.rejected[0]?.reason ??
          "Gemini returned no candidates that passed deterministic validation.",
        marketScan,
      };
    }

    const ranked = [...validation.accepted].sort(
      (a, b) => b.confidence - a.confidence,
    );
    const top = ranked[0]!;
    const market = geminiEligible.find((m) => m.marketId === top.marketId);
    if (!market) {
      return {
        ok: false,
        code: "unknown_market",
        reason: "Accepted Gemini marketId missing from snapshot.",
        marketScan,
      };
    }

    const selected = geminiCandidateToStrategyDecision({
      candidate: top,
      market,
      nowSec,
    });
    if (!selected) {
      return {
        ok: false,
        code: "no_enter_decision",
        reason:
          "Could not map Gemini decision to a tradable limit price from the book.",
        marketScan,
      };
    }

    if (top.stake > 0) resolvedStake = top.stake;
    marketScan.selected = 1;
    decision = attachMarketWindowMeta(selected, snapshot.markets);
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
      stake: resolvedStake,
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

  return {
    ok: true,
    userId: persisted.userId,
    tradeId,
    decision,
    intentSymbol: persisted.intent.symbol,
    stake: persisted.intent.stake,
    execution,
    marketScan,
  };
}

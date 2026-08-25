/**
 * Production execution wiring (Stage 6 entry boundary).
 *
 * Telegram identity → server-side user_id + wallet → Stage 2 decision →
 * persisted trade intent → executePersistedTradeForTelegram.
 *
 * Does not trust client-supplied user_id or wallet addresses.
 * Does not place orders itself — delegates to existing Stage 5 path.
 */

import type { AppConfig } from "../config.ts";
import type { DreamdexDiagnostic } from "./dreamdex.ts";
import type { LiveSubmitResult } from "./live-execution.ts";
import type { StrategyDecision, StrategyRunResult } from "./strategy.ts";
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

/** Production defaults — lazy so unit tests with injected deps never load the SDK. */
export async function loadDefaultTradeOrchestrationDeps(): Promise<TradeOrchestrationDeps> {
  const [{ readDreamdexMarkets }, { evaluateMarkets }, { createPersistedTradeIntent, expireStalePendingTradeIntentsForTelegram }, { executePersistedTradeForTelegram }] =
    await Promise.all([
      import("./dreamdex.ts"),
      import("./strategy.ts"),
      import("./trade-persistence.ts"),
      import("./trade-execution.ts"),
    ]);
  return {
    readMarkets: readDreamdexMarkets,
    evaluate: evaluateMarkets,
    expireStalePending: ({ config, identity, markets }) =>
      expireStalePendingTradeIntentsForTelegram(config, identity, markets),
    persistIntent: createPersistedTradeIntent as TradeOrchestrationDeps["persistIntent"],
    executePersisted: executePersistedTradeForTelegram,
  };
}

export type OrchestrationSuccess = {
  ok: true;
  userId: string;
  tradeId: string;
  decision: StrategyDecision;
  intentSymbol: string;
  stake: number;
  execution: LiveSubmitResult;
};

export type OrchestrationFailure = {
  ok: false;
  code: string;
  reason: string;
  userId?: string;
  tradeId?: string;
  decision?: StrategyDecision;
};

export type OrchestrationResult = OrchestrationSuccess | OrchestrationFailure;

function tradeIdFromPersisted(trade: unknown): string | null {
  if (!trade || typeof trade !== "object") return null;
  const id = (trade as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Select the highest-edge enter decision from a strategy run, if any.
 * evaluateMarkets already sorts enters by edge descending first.
 */
export function selectEnterDecision(
  run: StrategyRunResult,
): StrategyDecision | null {
  const enters = run.decisions.filter((d) => d.action === "enter");
  if (enters.length === 0) return null;
  return enters[0] ?? null;
}

/**
 * Authenticated production trade cycle.
 *
 * - Identity comes only from Telegram (`identity.id`).
 * - Wallet + internal user_id are resolved inside persist/execute helpers.
 * - liveExecutionRequested is caller-controlled; ENABLE_LIVE_EXECUTION still gates chain writes.
 */
export async function runTelegramTradeCycle(input: {
  config: AppConfig;
  identity: TelegramIdentity;
  /** When true, requests live path; still blocked if ENABLE_LIVE_EXECUTION is false. */
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
    !provided.evaluate ||
    !provided.persistIntent ||
    !provided.executePersisted;
  const defaults = needsDefaults
    ? await loadDefaultTradeOrchestrationDeps()
    : null;
  const deps: TradeOrchestrationDeps = {
    readMarkets: provided.readMarkets ?? defaults!.readMarkets,
    evaluate: provided.evaluate ?? defaults!.evaluate,
    persistIntent: provided.persistIntent ?? defaults!.persistIntent,
    executePersisted: provided.executePersisted ?? defaults!.executePersisted,
  };

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

  const strategy = deps.evaluate(snapshot.markets);
  const decision = selectEnterDecision(strategy);
  if (!decision) {
    return {
      ok: false,
      code: "no_enter_decision",
      reason: "Stage 2 produced no enter decision for the current markets.",
    };
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
      stake: input.stake,
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

  // Execution always goes through the existing authenticated boundary.
  // Never accepts a client wallet or user_id override.
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
  };
}

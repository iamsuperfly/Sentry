/**
 * Production execution wiring types and helpers.
 */

import type { AppConfig } from "../config.ts";
import type { DreamdexDiagnostic } from "./dreamdex.ts";
import type { LiveSubmitResult } from "./live-execution.ts";
import type { StrategyDecision, StrategyRunResult } from "./strategy.ts";
import type { TelegramIdentity } from "./trade-persistence.ts";
import type { CandidateTradeAttempt } from "./multi-ai-execution.ts";

export const ORCHESTRATION_MODULE = "stage-6-execution-wiring";
export type { CandidateTradeAttempt };
export { runTelegramTradeCycle } from "./run-telegram-trade-cycle.ts";

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

export function selectEnterDecision(
  run: StrategyRunResult,
): StrategyDecision | null {
  const enters = run.decisions.filter((d) => d.action === "enter");
  if (enters.length === 0) return null;
  return enters[0] ?? null;
}

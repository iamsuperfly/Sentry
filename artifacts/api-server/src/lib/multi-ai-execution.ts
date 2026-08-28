/**
 * Multi-candidate AI trade attempts: persist + execute each independently.
 * Failures on one candidate do not stop the others.
 */

import type { AppConfig } from "../config.ts";
import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";
import { attachMarketWindowMeta } from "./decision-market-meta.ts";
import type { LiveSubmitResult } from "./live-execution.ts";
import type { StrategyDecision } from "./strategy.ts";
import { geminiCandidateToStrategyDecision } from "./gemini-path.ts";
import { logger } from "./logger.ts";
import type { TelegramIdentity } from "./trade-persistence.ts";

export type AiValidatedCandidate = {
  marketId: string;
  direction: "UP" | "DOWN";
  confidence: number;
  reason: string;
  stake: number;
};

export type CandidateTradeAttempt = {
  marketId: string;
  asset: string;
  direction: string;
  stake: number;
  limitPriceHint: number | null;
  confidence?: number;
  reason?: string;
  tradeId?: string;
  intentSymbol?: string;
  decision?: StrategyDecision;
  execution?: LiveSubmitResult;
  ok: boolean;
  code?: string;
  reasonDetail?: string;
};

export type PersistResultForMulti =
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
  | { ok: false; code: string; reason: string; idempotencyKey?: string };

function tradeIdFromPersisted(trade: unknown): string | null {
  if (!trade || typeof trade !== "object") return null;
  const id = (trade as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function computeAvailableSlots(input: {
  userMaxOpen: number;
  systemMaxOpen: number;
  openCount: number;
}): number {
  const maxOpen = Math.min(input.userMaxOpen, input.systemMaxOpen);
  return Math.max(0, maxOpen - input.openCount);
}

export async function processAiCandidateTrades(input: {
  config: AppConfig;
  identity: TelegramIdentity;
  liveExecutionRequested: boolean;
  defaultStake: number;
  selectedCandidates: AiValidatedCandidate[];
  markets: DreamdexMarketDiagnostic[];
  nowSec: number;
  persistIntent: (input: {
    config: AppConfig;
    identity: TelegramIdentity;
    decision: StrategyDecision;
    stake?: number;
  }) => Promise<PersistResultForMulti>;
  executePersisted: (input: {
    config: AppConfig;
    identity: TelegramIdentity;
    tradeId: string;
    liveExecutionRequested: boolean;
  }) => Promise<LiveSubmitResult>;
}): Promise<CandidateTradeAttempt[]> {
  const attempts: CandidateTradeAttempt[] = [];

  for (const candidate of input.selectedCandidates) {
    const market = input.markets.find((m) => m.marketId === candidate.marketId);
    if (!market) {
      attempts.push({
        marketId: candidate.marketId,
        asset: "?",
        direction: candidate.direction,
        stake: candidate.stake > 0 ? candidate.stake : input.defaultStake,
        limitPriceHint: null,
        confidence: candidate.confidence,
        reason: candidate.reason,
        ok: false,
        code: "unknown_market",
        reasonDetail: "Accepted AI marketId missing from snapshot.",
      });
      continue;
    }

    const mapped = geminiCandidateToStrategyDecision({
      candidate,
      market,
      nowSec: input.nowSec,
    });
    if (!mapped) {
      attempts.push({
        marketId: candidate.marketId,
        asset: market.asset,
        direction: candidate.direction,
        stake: candidate.stake > 0 ? candidate.stake : input.defaultStake,
        limitPriceHint: null,
        confidence: candidate.confidence,
        reason: candidate.reason,
        ok: false,
        code: "no_enter_decision",
        reasonDetail:
          "Could not map AI decision to a tradable limit price from the book.",
      });
      continue;
    }

    const candDecision = attachMarketWindowMeta(mapped, input.markets);
    const candStake =
      candidate.stake > 0 ? candidate.stake : input.defaultStake;

    logger.info(
      {
        provider: "groq",
        marketId: candDecision.marketId,
        asset: candDecision.asset,
        direction: candDecision.direction,
        stake: candStake,
        confidence: candidate.confidence,
        limitPriceHint: candDecision.limitPriceHint,
      },
      "Trade candidate processing",
    );

    let persisted: PersistResultForMulti;
    try {
      persisted = await input.persistIntent({
        config: input.config,
        identity: input.identity,
        decision: candDecision,
        stake: candStake,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 200)
          : "Unable to persist trade intent.";
      attempts.push({
        marketId: candDecision.marketId,
        asset: candDecision.asset,
        direction: String(candDecision.direction),
        stake: candStake,
        limitPriceHint: candDecision.limitPriceHint,
        confidence: candidate.confidence,
        reason: candidate.reason,
        decision: candDecision,
        ok: false,
        code: "persist_failed",
        reasonDetail: message,
      });
      continue;
    }

    if (!persisted.ok) {
      attempts.push({
        marketId: candDecision.marketId,
        asset: candDecision.asset,
        direction: String(candDecision.direction),
        stake: candStake,
        limitPriceHint: candDecision.limitPriceHint,
        confidence: candidate.confidence,
        reason: candidate.reason,
        decision: candDecision,
        ok: false,
        code: persisted.code,
        reasonDetail: persisted.reason,
      });
      continue;
    }

    const tradeId = tradeIdFromPersisted(persisted.trade);
    if (!tradeId) {
      attempts.push({
        marketId: candDecision.marketId,
        asset: candDecision.asset,
        direction: String(candDecision.direction),
        stake: candStake,
        limitPriceHint: candDecision.limitPriceHint,
        confidence: candidate.confidence,
        reason: candidate.reason,
        decision: candDecision,
        ok: false,
        code: "missing_trade_id",
        reasonDetail: "Persisted trade row did not include an id.",
      });
      continue;
    }

    const execution = await input.executePersisted({
      config: input.config,
      identity: input.identity,
      tradeId,
      liveExecutionRequested: input.liveExecutionRequested,
    });

    attempts.push({
      marketId: candDecision.marketId,
      asset: candDecision.asset,
      direction: String(candDecision.direction),
      stake: persisted.intent.stake,
      limitPriceHint: candDecision.limitPriceHint,
      confidence: candidate.confidence,
      reason: candidate.reason,
      tradeId,
      intentSymbol: persisted.intent.symbol,
      decision: candDecision,
      execution,
      ok: execution.ok,
      code: execution.ok ? undefined : execution.code,
      reasonDetail: execution.ok ? undefined : execution.reason,
    });

    logger.info(
      {
        provider: "groq",
        marketId: candDecision.marketId,
        tradeId,
        stake: persisted.intent.stake,
        direction: candDecision.direction,
        status: execution.ok ? execution.status : "not submitted",
        code: execution.ok ? undefined : execution.code,
      },
      "Trade candidate processing complete",
    );
  }

  return attempts;
}

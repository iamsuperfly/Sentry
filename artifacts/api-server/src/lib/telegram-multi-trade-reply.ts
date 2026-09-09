/**
 * Format /trade reply for one or more independent trade attempts.
 */

import {
  formatTradeExecutionMessage,
  formatUserFacingTradeFailure,
} from "./telegram-trade-format.ts";
import type { CandidateTradeAttempt } from "./multi-ai-execution.ts";
import type { StrategyDecision } from "./strategy.ts";
import type { LiveSubmitResult } from "./live-execution.ts";

export function formatMultiTradeReply(input: {
  trades: CandidateTradeAttempt[];
  fallback: {
    tradeId: string;
    intentSymbol: string;
    decision: StrategyDecision;
    stake: number;
    execution: LiveSubmitResult;
  };
  marketsLine: string;
  executionMode: string;
  explorerTxBaseUrl: string;
}): string {
  void input.executionMode;
  void input.marketsLine;
  const attempts = input.trades;
  const tradeBlocks: string[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!;
    const exec = a.execution;
    const failed = !a.ok || (exec && !exec.ok);
    if (failed) {
      tradeBlocks.push(
        formatUserFacingTradeFailure({
          code: a.code ?? (exec && !exec.ok ? exec.code : "execution_failed"),
          reason:
            a.reasonDetail ??
            (exec && !exec.ok ? exec.reason : "Trade was not submitted."),
        }),
      );
      continue;
    }
    const decisionMeta = (a.decision ?? input.fallback.decision) as {
      tradingStart?: string;
      intervalSec?: string | null;
      expiry?: string;
    };
    const status = exec ? String(exec.status) : "ok";
    tradeBlocks.push(
      formatTradeExecutionMessage({
        tradeId: a.tradeId ?? "(none)",
        symbol: a.intentSymbol ?? a.asset,
        direction: String(a.direction ?? "n/a"),
        status,
        stake: a.stake,
        limitPrice: a.limitPriceHint,
        transactionHash: exec && exec.ok ? (exec.transactionHash ?? null) : null,
        tradingStart: decisionMeta.tradingStart,
        marketExpiry: a.decision?.expiry ?? input.fallback.decision.expiry,
        intervalSec: decisionMeta.intervalSec,
        explorerTxBaseUrl: input.explorerTxBaseUrl,
      }),
    );
  }

  const lines = [`Trades: ${attempts.length}`];
  if (tradeBlocks.length > 0) lines.push("", ...tradeBlocks);
  return lines.join("\n");
}
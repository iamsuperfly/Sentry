/**
 * Shared types for one-or-more trade attempts after a decision.
 */

import type { LiveSubmitResult } from "./live-execution.ts";
import type { StrategyDecision } from "./strategy.ts";

export type CandidateTradeAttempt = {
  marketId: string;
  asset: string;
  direction: string;
  stake: number;
  limitPriceHint: number | null;
  reason?: string;
  tradeId?: string;
  intentSymbol?: string;
  decision?: StrategyDecision;
  execution?: LiveSubmitResult;
  ok: boolean;
  code?: string;
  reasonDetail?: string;
};

export function computeAvailableSlots(input: {
  userMaxOpen: number;
  systemMaxOpen: number;
  openCount: number;
}): number {
  const maxOpen = Math.min(input.userMaxOpen, input.systemMaxOpen);
  return Math.max(0, maxOpen - input.openCount);
}

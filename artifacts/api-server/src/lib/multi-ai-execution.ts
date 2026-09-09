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

/** Ranked candidates kept in order; take min(eligible, available slots). */
export function takeRankedUpToSlots<T>(
  ranked: readonly T[],
  availableSlots: number,
): T[] {
  if (!Number.isFinite(availableSlots) || availableSlots <= 0) return [];
  return ranked.slice(0, Math.floor(availableSlots));
}

export const SLOT_EXHAUSTED_CODES = new Set([
  "user_max_open_positions",
  "system_max_open_positions",
]);

export const DAY_HALT_CODES = new Set([
  "trading_disabled",
  "user_daily_loss_stop",
  "system_daily_loss_stop",
  "daily_profit_target_reached",
]);

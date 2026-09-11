/**
 * Pure autonomous tick policy. WS wakes the existing engine in "trading"
 * mode; the 6-minute loop remains the full reconciliation fallback.
 */

import {
  looksLikeBookMiss,
  looksLikeIocNoFill,
} from "./telegram-user-errors.ts";

export type AutonomousTickMode = "full" | "trading";

export const DEFAULT_AUTONOMOUS_INTERVAL_MS = 5 * 60 * 1000;

const HALT_CODES = new Set([
  "user_daily_loss_stop",
  "system_daily_loss_stop",
  "daily_profit_target_reached",
  "trading_disabled",
]);

const QUIET_SCAN_CODES = new Set([
  "no_enter_decision",
  "book_stale",
  "no_usable_ask",
  "insufficient_liquidity",
  "post_only_would_cross",
  "post_only_unavailable",
]);

export function shouldRunMaintenancePhases(mode: AutonomousTickMode): boolean {
  return mode === "full";
}

export function shouldMarkAutonomousScan(mode: AutonomousTickMode): boolean {
  return mode === "full";
}

/** book_change is rate-limited; new windows skip the interval so WS stays useful. */
export function wsTradingMinIntervalMs(kind: string, debounceMs: number): number {
  return kind === "book_change" ? debounceMs : 0;
}

export function shouldNotifyAutonomousScan(input: {
  ok: boolean;
  code?: string | null;
  reason?: string | null;
  placedCount: number;
}): boolean {
  if (input.placedCount > 0) return true;
  const code = (input.code ?? "").toLowerCase();
  if (HALT_CODES.has(code)) return true;
  if (QUIET_SCAN_CODES.has(code)) return false;
  if (looksLikeBookMiss(input.code ?? "", input.reason) || looksLikeIocNoFill(input.code ?? "", input.reason)) {
    return false;
  }
  return !input.ok;
}

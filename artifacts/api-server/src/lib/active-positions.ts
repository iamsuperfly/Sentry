/**
 * Shared definition of "active open position" for /positions and /status.
 * Same expiry-aware rule as listActivePositionsForDisplay.
 */

import type { AppConfig } from "../config.ts";
import { shouldShowInPositions } from "./position-lifecycle.ts";
import { getSupabaseClient } from "./supabase.ts";
import { OPEN_TRADE_STATUSES } from "./trade-state.ts";

function decisionExpiry(decision: unknown): string | number | null {
  if (!decision || typeof decision !== "object") return null;
  const d = decision as Record<string, unknown>;
  return (d.expiry as string | number | null | undefined) ?? null;
}

/**
 * Count positions that would appear on /positions (open status + market still open).
 */
export async function getActiveOpenPositionCount(
  config: AppConfig,
  userId: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<number> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("id, status, decision")
    .eq("user_id", userId)
    .in("status", [...OPEN_TRADE_STATUSES]);

  if (error) throw new Error("Unable to read open positions.");

  let count = 0;
  for (const row of data ?? []) {
    if (
      shouldShowInPositions({
        status: String(row.status),
        marketExpiry: decisionExpiry(row.decision),
        nowSec,
      })
    ) {
      count += 1;
    }
  }
  return count;
}

/** Pure helper for unit tests — same filter without DB. */
export function countActivePositionsFromRows(
  rows: Array<{ status: string; marketExpiry?: string | number | null }>,
  nowSec: number,
): number {
  return rows.filter((row) =>
    shouldShowInPositions({
      status: row.status,
      marketExpiry: row.marketExpiry,
      nowSec,
    }),
  ).length;
}

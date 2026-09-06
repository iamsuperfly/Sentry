import type { AppConfig } from "../config.ts";
import { getSupabaseClient } from "./supabase.ts";
import {
  formatPerformanceMessage,
  summarizePerformance,
  type PerformanceSummary,
  type PerformanceTrade,
} from "./performance-summary.ts";
import {
  DEFAULT_USER_TIMEZONE,
  getZonedDayBounds,
} from "./user-timezone.ts";

const ALL_TIME_ROW_CAP = 10_000;

export async function loadPerformanceTrades(
  config: AppConfig,
  userId: string,
  limit = ALL_TIME_ROW_CAP,
): Promise<PerformanceTrade[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("status, pnl_usdso, stake_usdso, outcome, settled_at")
    .eq("user_id", userId)
    .in("status", ["settled", "redeemed", "cancelled", "failed"])
    .order("settled_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error("Unable to load performance trades.");
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      status: String(r.status ?? ""),
      pnl: num(r.pnl_usdso),
      stake: Number(r.stake_usdso ?? 0),
      outcome: (r.outcome as string | null) ?? null,
      settledAt: (r.settled_at as string | null) ?? null,
    };
  });
}

export async function listUtcDayTradeStatuses(
  config: AppConfig,
  userId: string,
  now = new Date(),
): Promise<Array<{ status: string }>> {
  const { start, end } = getZonedDayBounds(now, DEFAULT_USER_TIMEZONE);
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("status")
    .eq("user_id", userId)
    .gte("created_at", start)
    .lt("created_at", end);
  if (error) throw new Error("Unable to read today's trades.");
  return (data ?? []).map((row) => ({
    status: String((row as { status?: string }).status ?? ""),
  }));
}

export async function getPerformanceSummary(
  config: AppConfig,
  userId: string,
  now = new Date(),
  timeZone: string = DEFAULT_USER_TIMEZONE,
): Promise<PerformanceSummary> {
  const trades = await loadPerformanceTrades(config, userId);
  return summarizePerformance(trades, now, timeZone);
}

export async function formatUserPerformance(
  config: AppConfig,
  userId: string,
  timeZone: string = DEFAULT_USER_TIMEZONE,
): Promise<string> {
  const summary = await getPerformanceSummary(config, userId, new Date(), timeZone);
  return formatPerformanceMessage(summary);
}

import type { AppConfig } from "../config.ts";
import { getSupabaseClient } from "./supabase.ts";
import {
  formatPerformanceMessage,
  summarizePerformance,
  type PerformanceSummary,
  type PerformanceTrade,
} from "./performance-summary.ts";

export async function loadPerformanceTrades(
  config: AppConfig,
  userId: string,
  limit = 500,
): Promise<PerformanceTrade[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("status, pnl_usdso, stake_usdso, outcome, settled_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
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

export async function getPerformanceSummary(
  config: AppConfig,
  userId: string,
  now = new Date(),
): Promise<PerformanceSummary> {
  const trades = await loadPerformanceTrades(config, userId);
  return summarizePerformance(trades, now);
}

export async function formatUserPerformance(
  config: AppConfig,
  userId: string,
): Promise<string> {
  const summary = await getPerformanceSummary(config, userId);
  return formatPerformanceMessage(summary);
}

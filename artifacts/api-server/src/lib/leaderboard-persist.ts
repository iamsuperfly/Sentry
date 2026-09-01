import type { AppConfig } from "../config.ts";
import { getSupabaseClient } from "./supabase.ts";
import {
  aggregateLeaderboard,
  formatLeaderboardMessage,
  type LeaderboardTrade,
} from "./leaderboard.ts";

export async function loadLeaderboardTrades(
  config: AppConfig,
): Promise<LeaderboardTrade[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(
      "user_id, status, pnl_usdso, outcome, settled_at, telegram_users(username, first_name)",
    )
    .in("status", ["settled", "redeemed"])
    .not("pnl_usdso", "is", null)
    .limit(5000);
  if (error) throw new Error("Unable to load leaderboard trades.");

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const user = r.telegram_users as
      | { username?: string | null; first_name?: string | null }
      | { username?: string | null; first_name?: string | null }[]
      | null;
    const profile = Array.isArray(user) ? user[0] : user;
    const pnl = Number(r.pnl_usdso);
    return {
      userId: String(r.user_id),
      username: profile?.username ?? null,
      firstName: profile?.first_name ?? null,
      status: String(r.status ?? ""),
      pnl: Number.isFinite(pnl) ? pnl : null,
      outcome: (r.outcome as string | null) ?? null,
      settledAt: (r.settled_at as string | null) ?? null,
    };
  });
}

export async function getLeaderboardMessage(
  config: AppConfig,
  viewerUserId: string,
  now = new Date(),
): Promise<string> {
  const trades = await loadLeaderboardTrades(config);
  const allTime = aggregateLeaderboard(trades, {
    now,
    timeZone: "UTC",
    daily: false,
  });
  const today = aggregateLeaderboard(trades, { now, timeZone: "UTC", daily: true });
  return formatLeaderboardMessage({
    allTime,
    today,
    viewerUserId,
    timeZone: "UTC",
  });
}

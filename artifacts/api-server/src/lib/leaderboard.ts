/** Rank users by realized PnL from settled/redeemed trades only. */

import { classifySettledResult } from "./performance-summary.ts";
import { isInstantInLocalDay } from "./user-timezone.ts";

export type LeaderboardTrade = {
  userId: string;
  username: string | null;
  firstName: string | null;
  status: string;
  pnl: number | null;
  outcome: string | null;
  settledAt: string | null;
};

export type LeaderboardEntry = {
  userId: string;
  displayName: string;
  pnl: number;
  latestSettledAt: string | null;
  rank: number;
};

export function displayIdentity(input: {
  username: string | null;
  firstName: string | null;
}): string {
  const username = input.username?.replace(/^@/, "").trim();
  if (username) return `@${username}`;
  const first = input.firstName?.trim();
  if (first) return first;
  return "anonymous";
}

function finite(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return Number.isFinite(n) ? n : null;
}

export function aggregateLeaderboard(
  trades: LeaderboardTrade[],
  options: { now: Date; timeZone: string; daily: boolean },
): LeaderboardEntry[] {
  const byUser = new Map<
    string,
    {
      userId: string;
      displayName: string;
      pnl: number;
      latestSettledAt: string | null;
    }
  >();

  for (const trade of trades) {
    const kind = classifySettledResult(trade);
    if (kind === "ignored" || kind === "unknown") continue;
    const pnl = finite(trade.pnl);
    if (pnl === null) continue;
    if (options.daily && !isInstantInLocalDay(trade.settledAt, options.now, options.timeZone)) {
      continue;
    }
    const current = byUser.get(trade.userId) ?? {
      userId: trade.userId,
      displayName: displayIdentity(trade),
      pnl: 0,
      latestSettledAt: null,
    };
    current.pnl += pnl;
    if (
      trade.settledAt &&
      (!current.latestSettledAt || trade.settledAt > current.latestSettledAt)
    ) {
      current.latestSettledAt = trade.settledAt;
    }
    byUser.set(trade.userId, current);
  }

  const ranked = [...byUser.values()].sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    const at = a.latestSettledAt ?? "";
    const bt = b.latestSettledAt ?? "";
    if (bt !== at) return bt < at ? -1 : 1;
    return a.userId.localeCompare(b.userId);
  });

  return ranked.map((row, index) => ({
    ...row,
    pnl: Math.round(row.pnl * 1e6) / 1e6,
    rank: index + 1,
  }));
}

export function formatLeaderboardMessage(input: {
  allTime: LeaderboardEntry[];
  today: LeaderboardEntry[];
  viewerUserId: string;
  timeZone: string;
}): string {
  const top = input.allTime.slice(0, 10);
  const mineAll = input.allTime.find((e) => e.userId === input.viewerUserId);
  const mineToday = input.today.find((e) => e.userId === input.viewerUserId);
  const line = (e: LeaderboardEntry) =>
    `${e.rank}. ${e.displayName} ${e.pnl > 0 ? "+" : ""}${e.pnl}`;

  const lines = [
    "Leaderboard — All Time",
    "",
    top.length > 0 ? top.map(line).join("\n") : "No settled trades yet.",
    "",
    "Your position:",
    mineAll
      ? `#${mineAll.rank} ${mineAll.displayName} ${mineAll.pnl > 0 ? "+" : ""}${mineAll.pnl}`
      : "No settled all-time PnL yet.",
    "",
    "Today:",
    mineToday
      ? `#${mineToday.rank} ${mineToday.displayName} ${mineToday.pnl > 0 ? "+" : ""}${mineToday.pnl}`
      : "No settled PnL today.",
  ];
  return lines.join("\n");
}

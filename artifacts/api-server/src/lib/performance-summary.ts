/**
 * Realized PnL and unclaimed-payout accounting.
 * Open/failed/unknown-PnL trades never invent numbers.
 */

import { DEFAULT_USER_TIMEZONE, isInstantInLocalDay } from "./user-timezone.ts";

export type PerformanceTrade = {
  status: string;
  pnl: number | null;
  stake: number;
  outcome: string | null;
  settledAt: string | null;
};

export type PerformanceSummary = {
  allTimePnl: number;
  dailyPnl: number;
  reconstructedCount: number;
  excludedUnknownPnl: number;
  settledTrades: number;
  wins: number;
  losses: number;
  voids: number;
  unclaimedPositions: number;
  unclaimedValue: number;
};

function finitePnl(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isResolvedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "settled" || s === "redeemed";
}

export function classifySettledResult(input: {
  status: string;
  pnl: number | null;
  outcome: string | null;
}): "win" | "loss" | "void" | "unknown" | "ignored" {
  const status = input.status.toLowerCase();
  if (status === "failed" || status === "cancelled") return "ignored";
  if (!isResolvedStatus(status)) return "ignored";
  if (input.outcome === "void") return "void";
  const pnl = finitePnl(input.pnl);
  if (pnl === null) return "unknown";
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  if (input.outcome === "up" || input.outcome === "down") return "loss";
  return "unknown";
}

export function unclaimedPayout(input: {
  status: string;
  pnl: number | null;
  stake: number;
  outcome: string | null;
}): number | null {
  if (input.status.toLowerCase() !== "settled") return null;
  const kind = classifySettledResult(input);
  if (kind !== "win" && kind !== "void") return null;
  const pnl = finitePnl(input.pnl);
  if (pnl === null) return null;
  const payout = input.stake + pnl;
  if (!Number.isFinite(payout) || payout <= 0) return null;
  return Math.round(payout * 1e6) / 1e6;
}

export function summarizePerformance(
  trades: PerformanceTrade[],
  now = new Date(),
  timeZone: string = DEFAULT_USER_TIMEZONE,
): PerformanceSummary {
  const summary: PerformanceSummary = {
    allTimePnl: 0,
    dailyPnl: 0,
    reconstructedCount: 0,
    excludedUnknownPnl: 0,
    settledTrades: 0,
    wins: 0,
    losses: 0,
    voids: 0,
    unclaimedPositions: 0,
    unclaimedValue: 0,
  };

  for (const trade of trades) {
    const kind = classifySettledResult(trade);
    if (kind === "ignored") continue;
    if (kind === "unknown") {
      summary.excludedUnknownPnl += 1;
      continue;
    }

    summary.settledTrades += 1;
    if (kind === "win") summary.wins += 1;
    else if (kind === "loss") summary.losses += 1;
    else summary.voids += 1;

    const pnl = finitePnl(trade.pnl);
    if (pnl === null) continue;
    summary.reconstructedCount += 1;
    summary.allTimePnl += pnl;
    if (isInstantInLocalDay(trade.settledAt, now, timeZone)) summary.dailyPnl += pnl;

    const claimable = unclaimedPayout(trade);
    if (claimable !== null) {
      summary.unclaimedPositions += 1;
      summary.unclaimedValue += claimable;
    }
  }

  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  summary.allTimePnl = round(summary.allTimePnl);
  summary.dailyPnl = round(summary.dailyPnl);
  summary.unclaimedValue = round(summary.unclaimedValue);
  return summary;
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n}`;
}

export function formatPerformanceMessage(summary: PerformanceSummary): string {
  return [
    "Performance (Shannon testnet)",
    "",
    "Today",
    `PnL: ${signed(summary.dailyPnl)} tUSDC`,
    "",
    "All time",
    `PnL: ${signed(summary.allTimePnl)} tUSDC`,
    "",
    "Unclaimed",
    `Positions: ${summary.unclaimedPositions}`,
    `Value: ${summary.unclaimedValue} tUSDC`,
    "",
    `Settled trades: ${summary.settledTrades}`,
    `Wins: ${summary.wins}`,
    `Losses: ${summary.losses}`,
    summary.voids > 0 ? `Voids: ${summary.voids}` : "",
    summary.excludedUnknownPnl > 0
      ? `Excluded (PnL not reconstructed): ${summary.excludedUnknownPnl}`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

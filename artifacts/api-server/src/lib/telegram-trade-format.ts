/**
 * Pure Telegram trade display helpers.
 * No network, no bot side effects — safe to unit test.
 */

import { resolveMarketDurationSeconds } from "./decision-market-meta.ts";
import { sanitizeTechnicalErrorNote } from "./telegram-user-errors.ts";

export function parseUnixSeconds(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return n >= 1e12 ? n / 1000 : n;
}

export function marketDurationSeconds(
  tradingStart: string | number | null | undefined,
  expiry: string | number | null | undefined,
  intervalSec?: string | number | null,
): number | null {
  return resolveMarketDurationSeconds({
    intervalSec,
    tradingStart,
    expiry,
  });
}

export function formatTimeframe(durationSec: number | null | undefined): string {
  if (durationSec === null || durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) {
    return "n/a";
  }
  const total = Math.round(durationSec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0 && minutes === 0 && seconds === 0) return `${hours}h`;
  if (hours > 0 && minutes > 0 && seconds === 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0 && seconds === 0) return `${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function secondsUntilExpiry(
  expiry: string | number | null | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): number | null {
  const end = parseUnixSeconds(expiry);
  if (end === null) return null;
  return end - nowSec;
}

export function formatRemaining(secondsLeft: number | null | undefined): string {
  if (secondsLeft === null || secondsLeft === undefined || !Number.isFinite(secondsLeft)) {
    return "n/a";
  }
  if (secondsLeft <= 0) return "resolved";
  const total = Math.floor(secondsLeft);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${minutes}m ${pad(seconds)}s`;
}

export function explorerTxUrl(explorerTxBaseUrl: string, hash: string): string {
  const base = explorerTxBaseUrl.replace(/\/$/, "");
  return `${base}/${hash}`;
}

export function formatExplorerLinkLine(
  explorerTxBaseUrl: string,
  hash: string | null | undefined,
): string | null {
  if (!hash) return null;
  return `Tx: ${explorerTxUrl(explorerTxBaseUrl, hash)}`;
}

export type DisplayTrade = {
  id: string;
  symbol: string;
  direction: string;
  status: string;
  stake: number;
  limitPrice: number | null;
  filledContracts: number | null;
  contracts: number | null;
  transactionHash: string | null;
  errorMessage: string | null;
  marketExpiry?: string | number | null;
  tradingStart?: string | number | null;
  intervalSec?: string | number | null;
  outcome?: string | null;
  pnl?: number | null;
  markPrice?: number | null;
};

function directionLabel(direction: string): string {
  const d = direction.toLowerCase();
  if (d === "up" || d === "yes") return "YES UP";
  if (d === "down" || d === "no") return "NO DOWN";
  return direction.toUpperCase();
}

export function formatOrderStatusLabel(status: string): string {
  const s = status.toLowerCase();
  switch (s) {
    case "pending":
      return "pending (intent recorded, not yet on-chain)";
    case "submitted":
      return "submitted (order sent on-chain)";
    case "partially_filled":
      return "partially filled";
    case "filled":
      return "filled (position open until market resolves)";
    case "cancelled":
      return "cancelled";
    case "settled":
      return "settled (market resolved; payout may still need claim)";
    case "redeemed":
      return "redeemed (payout claimed to wallet)";
    case "failed":
      return "failed";
    default:
      return status;
  }
}

export function estimateUnrealizedPnl(input: {
  direction: string;
  stake: number;
  entryPrice: number | null | undefined;
  filledContracts: number | null | undefined;
  markPrice: number | null | undefined;
}): number | null {
  const entry = input.entryPrice;
  const mark = input.markPrice;
  const contracts = input.filledContracts;
  if (
    entry === null || entry === undefined || !Number.isFinite(entry) || entry <= 0 ||
    mark === null || mark === undefined || !Number.isFinite(mark) ||
    contracts === null || contracts === undefined || !Number.isFinite(contracts) || contracts <= 0
  ) {
    return null;
  }
  const d = input.direction.toLowerCase();
  let positionMark: number;
  if (d === "up" || d === "yes") positionMark = mark;
  else if (d === "down" || d === "no") positionMark = 1 - mark;
  else return null;
  const pnl = contracts * (positionMark - entry);
  return Number.isFinite(pnl) ? Math.round(pnl * 1e6) / 1e6 : null;
}

export function formatPositionBlock(
  trade: DisplayTrade,
  explorerTxBaseUrl: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const duration = marketDurationSeconds(trade.tradingStart, trade.marketExpiry, trade.intervalSec);
  const timeframe = formatTimeframe(duration);
  const left = secondsUntilExpiry(trade.marketExpiry, nowSec);
  const remaining =
    left === null ? "n/a" : left <= 0 ? "market window ended" : formatRemaining(left);
  const price =
    trade.limitPrice === null || trade.limitPrice === undefined ? "n/a" : String(trade.limitPrice);
  const fill =
    trade.filledContracts !== null && trade.filledContracts !== undefined &&
    trade.contracts !== null && trade.contracts !== undefined
      ? `Contracts: ${trade.filledContracts} / ${trade.contracts}`
      : trade.filledContracts !== null && trade.filledContracts !== undefined
        ? `Contracts filled: ${trade.filledContracts}`
        : null;
  const tx = formatExplorerLinkLine(explorerTxBaseUrl, trade.transactionHash);
  const unrealized = estimateUnrealizedPnl({
    direction: trade.direction,
    stake: trade.stake,
    entryPrice: trade.limitPrice,
    filledContracts: trade.filledContracts,
    markPrice: trade.markPrice,
  });
  const lines = [
    `${trade.symbol} · ${directionLabel(trade.direction)} · ${timeframe}`,
    `Order: ${formatOrderStatusLabel(trade.status)}`,
    `Time left: ${remaining}`,
    `Stake: ${trade.stake} tUSDC`,
    `Entry price: ${price}`,
  ];
  if (fill) lines.push(fill);
  if (unrealized !== null) {
    const sign = unrealized > 0 ? "+" : "";
    lines.push(`Unrealized (mark): ${sign}${unrealized} tUSDC`);
  } else if (trade.status === "filled" || trade.status === "partially_filled") {
    lines.push("Unrealized: n/a (no live mark)");
  }
  if (tx) lines.push(tx);
  const note = sanitizeTechnicalErrorNote(trade.errorMessage);
  if (note) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

export function formatHistoryBlock(
  trade: DisplayTrade,
  explorerTxBaseUrl: string,
): string {
  const duration = marketDurationSeconds(trade.tradingStart, trade.marketExpiry, trade.intervalSec);
  const timeframe = formatTimeframe(duration);
  const price =
    trade.limitPrice === null || trade.limitPrice === undefined ? "n/a" : String(trade.limitPrice);
  const kind = classifyFinalization({
    status: trade.status,
    outcome: trade.outcome,
    pnl: trade.pnl,
  });
  const resultLabel =
    kind === "win" ? "WIN"
    : kind === "loss" ? "LOSS"
    : kind === "void" ? "VOID"
    : kind === "failed" ? "FAILED"
    : kind === "cancelled" ? "CANCELLED"
    : trade.status.toUpperCase();
  const lines = [
    `${trade.symbol} · ${directionLabel(trade.direction)} · ${timeframe}`,
    `Result: ${resultLabel}`,
    `Status: ${formatOrderStatusLabel(trade.status)}`,
    `Stake: ${trade.stake} tUSDC`,
    `Entry price: ${price}`,
  ];
  if (trade.filledContracts !== null && trade.filledContracts !== undefined) {
    lines.push(`Contracts: ${trade.filledContracts}`);
  }
  if (trade.pnl !== null && trade.pnl !== undefined && Number.isFinite(trade.pnl)) {
    const sign = trade.pnl > 0 ? "+" : "";
    lines.push(`PnL: ${sign}${trade.pnl} tUSDC`);
    if (kind === "win" && trade.stake + trade.pnl > 0) {
      lines.push(`Payout (if claimed): ${trade.stake + trade.pnl} tUSDC`);
    }
  } else if (trade.status === "settled" || trade.status === "redeemed") {
    lines.push("PnL: n/a (not reconstructed)");
  }
  const tx = formatExplorerLinkLine(explorerTxBaseUrl, trade.transactionHash);
  if (tx) lines.push(tx);
  return lines.join("\n");
}

export function formatTradeExecutionMessage(input: {
  tradeId: string;
  symbol: string;
  direction: string;
  status: string;
  stake: number;
  limitPrice: number | null;
  transactionHash: string | null;
  tradingStart?: string | number | null;
  marketExpiry?: string | number | null;
  intervalSec?: string | number | null;
  explorerTxBaseUrl: string;
  nowSec?: number;
}): string {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const duration = marketDurationSeconds(input.tradingStart, input.marketExpiry, input.intervalSec);
  const timeframe = formatTimeframe(duration);
  const left = secondsUntilExpiry(input.marketExpiry, nowSec);
  const remaining =
    left === null ? "n/a" : left <= 0 ? "resolved" : formatRemaining(left);
  const price =
    input.limitPrice === null || input.limitPrice === undefined ? "n/a" : String(input.limitPrice);
  const tx = formatExplorerLinkLine(input.explorerTxBaseUrl, input.transactionHash);
  const lines = [
    "\u2705 Trade update",
    "",
    `Trade ID: ${input.tradeId}`,
    `Market: ${input.symbol} · ${timeframe}`,
    `Direction: ${directionLabel(input.direction)}`,
    `Resolves in: ${remaining}`,
    `Stake: ${input.stake} tUSDC`,
    `Limit/fill price: ${price}`,
    `Status: ${input.status}`,
  ];
  if (tx) lines.push(tx);
  return lines.join("\n");
}

export type FinalizationKind = "win" | "loss" | "void" | "failed" | "cancelled" | "settled";

export function classifyFinalization(input: {
  status: string;
  outcome?: string | null;
  pnl?: number | null;
}): FinalizationKind {
  const status = input.status.toLowerCase();
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (input.outcome === "void") return "void";
  if (input.pnl !== null && input.pnl !== undefined && Number.isFinite(input.pnl)) {
    if (input.pnl > 0) return "win";
    if (input.pnl < 0) return "loss";
  }
  if (input.outcome === "up" || input.outcome === "down") return "settled";
  return "settled";
}

export function formatFinalizationMessage(input: {
  symbol: string;
  direction: string;
  status: string;
  stake: number;
  outcome?: string | null;
  pnl?: number | null;
  tradingStart?: string | number | null;
  marketExpiry?: string | number | null;
  intervalSec?: string | number | null;
  transactionHash?: string | null;
  errorMessage?: string | null;
  explorerTxBaseUrl: string;
}): string {
  const kind = classifyFinalization(input);
  const duration = marketDurationSeconds(input.tradingStart, input.marketExpiry, input.intervalSec);
  const timeframe = formatTimeframe(duration);
  const header =
    kind === "win" ? "\u2705 Trade finalized"
    : kind === "loss" ? "\u274c Trade finalized"
    : kind === "failed" || kind === "cancelled" ? "\u26a0\ufe0f Trade closed"
    : "\u2139\ufe0f Trade finalized";
  const resultLabel =
    kind === "win" ? "WIN"
    : kind === "loss" ? "LOSS"
    : kind === "void" ? "VOID"
    : kind === "failed" ? "FAILED"
    : kind === "cancelled" ? "CANCELLED"
    : input.status.toUpperCase();
  const lines = [
    header,
    "",
    `${input.symbol} · ${directionLabel(input.direction)} · ${timeframe}`,
    `Result: ${resultLabel}`,
    `Stake: ${input.stake} tUSDC`,
  ];
  if (input.pnl !== null && input.pnl !== undefined && Number.isFinite(input.pnl)) {
    const payout = input.stake + input.pnl;
    if (kind === "win" && payout > 0) lines.push(`Payout: ${payout} tUSDC`);
    const sign = input.pnl > 0 ? "+" : "";
    lines.push(`PnL: ${sign}${input.pnl} tUSDC`);
  }
  lines.push(`Final status: ${input.status}`);
  const tx = formatExplorerLinkLine(input.explorerTxBaseUrl, input.transactionHash ?? null);
  if (tx) lines.push(tx);
  const reasonNote = sanitizeTechnicalErrorNote(input.errorMessage);
  if (reasonNote) lines.push(`Reason: ${reasonNote}`);
  return lines.join("\n");
}

export {
  extractPnlFromReason,
  formatUserFacingTradeFailure,
  looksLikeAllowanceOrRpc,
  looksLikeIocNoFill,
  sanitizeTechnicalErrorNote,
} from "./telegram-user-errors.ts";

export function formatExecutionModeLabel(mode: string): string {
  if (mode === "paper") return "paper (no on-chain orders)";
  if (mode === "testnet") return "testnet";
  return mode;
}

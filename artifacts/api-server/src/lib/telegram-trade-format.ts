/**
 * Pure Telegram trade display helpers.
 * No network, no bot side effects — safe to unit test.
 */

import { resolveMarketDurationSeconds } from "./decision-market-meta.ts";

export function parseUnixSeconds(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  // ms timestamps are ~1e12+; seconds are ~1e9.
  return n >= 1e12 ? n / 1000 : n;
}

/**
 * Market window length from tradingStart → expiry (actual metadata).
 */
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

/**
 * Format duration seconds as product-style timeframe labels.
 * 5 → "5m", 30 → "30m", 60 → "1h", 90 → "1h 30m".
 */
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

/**
 * Countdown until market resolution. Negative/zero → already resolved.
 */
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
  /** Unix seconds or ms string from market metadata / decision. */
  marketExpiry?: string | number | null;
  tradingStart?: string | number | null;
  intervalSec?: string | number | null;
  outcome?: string | null;
  pnl?: number | null;
};

function directionLabel(direction: string): string {
  const d = direction.toLowerCase();
  if (d === "up" || d === "yes") return "YES UP";
  if (d === "down" || d === "no") return "NO DOWN";
  return direction.toUpperCase();
}

export function formatPositionBlock(
  trade: DisplayTrade,
  explorerTxBaseUrl: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const duration = marketDurationSeconds(
    trade.tradingStart,
    trade.marketExpiry,
    trade.intervalSec,
  );
  const timeframe = formatTimeframe(duration);
  const left = secondsUntilExpiry(trade.marketExpiry, nowSec);
  const remaining =
    left === null
      ? "n/a"
      : left <= 0
        ? "resolved"
        : formatRemaining(left);
  const price =
    trade.limitPrice === null || trade.limitPrice === undefined
      ? "n/a"
      : String(trade.limitPrice);
  const fill =
    trade.filledContracts !== null &&
    trade.filledContracts !== undefined &&
    trade.contracts !== null &&
    trade.contracts !== undefined
      ? `Fill: ${trade.filledContracts} / ${trade.contracts} contracts`
      : null;
  const tx = formatExplorerLinkLine(explorerTxBaseUrl, trade.transactionHash);
  const lines = [
    `${trade.symbol} · ${directionLabel(trade.direction)} · ${timeframe}`,
    `Order status: ${trade.status}`,
    `Resolves in: ${remaining}`,
    `Stake: ${trade.stake} tUSDC`,
    `Limit/fill price: ${price}`,
  ];
  if (fill) lines.push(fill);
  if (tx) lines.push(tx);
  if (trade.errorMessage) lines.push(`Note: ${trade.errorMessage}`);
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
  const duration = marketDurationSeconds(
    input.tradingStart,
    input.marketExpiry,
    input.intervalSec,
  );
  const timeframe = formatTimeframe(duration);
  const left = secondsUntilExpiry(input.marketExpiry, nowSec);
  const remaining =
    left === null
      ? "n/a"
      : left <= 0
        ? "resolved"
        : formatRemaining(left);
  const price =
    input.limitPrice === null || input.limitPrice === undefined
      ? "n/a"
      : String(input.limitPrice);
  const tx = formatExplorerLinkLine(
    input.explorerTxBaseUrl,
    input.transactionHash,
  );
  const lines = [
    "✅ Trade update",
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
  if (input.outcome === "up" || input.outcome === "down") {
    return "settled";
  }
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
  const duration = marketDurationSeconds(
    input.tradingStart,
    input.marketExpiry,
    input.intervalSec,
  );
  const timeframe = formatTimeframe(duration);
  const header =
    kind === "win"
      ? "✅ Trade finalized"
      : kind === "loss"
        ? "❌ Trade finalized"
        : kind === "failed" || kind === "cancelled"
          ? "⚠️ Trade closed"
          : "ℹ️ Trade finalized";
  const resultLabel =
    kind === "win"
      ? "WIN"
      : kind === "loss"
        ? "LOSS"
        : kind === "void"
          ? "VOID"
          : kind === "failed"
            ? "FAILED"
            : kind === "cancelled"
              ? "CANCELLED"
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
    if (kind === "win" && payout > 0) {
      lines.push(`Payout: ${payout} tUSDC`);
    }
    const sign = input.pnl > 0 ? "+" : "";
    lines.push(`PnL: ${sign}${input.pnl} tUSDC`);
  }
  lines.push(`Final status: ${input.status}`);
  const tx = formatExplorerLinkLine(
    input.explorerTxBaseUrl,
    input.transactionHash ?? null,
  );
  if (tx) lines.push(tx);
  if (input.errorMessage) lines.push(`Reason: ${input.errorMessage}`);
  return lines.join("\n");
}

/**
 * Map internal trade-cycle / risk codes to concise user-facing Telegram text.
 * Never expose stage numbers, DB field names, or implementation codes.
 */
export function formatUserFacingTradeFailure(input: {
  code: string;
  reason?: string | null;
}): string {
  const code = (input.code || "").toLowerCase();
  switch (code) {
    case "no_enter_decision":
      return [
        "⚪ No trade placed",
        "",
        "No market currently meets the strategy's conditions.",
        "No funds were used.",
      ].join("\n");
    case "trading_disabled":
      return [
        "⚪ Trading is turned off",
        "",
        "Enable it with /settings trading on, or review /settings.",
      ].join("\n");
    case "markets_unavailable":
      return [
        "⚪ Markets unavailable",
        "",
        "Could not load market data right now. Try again shortly.",
        "No funds were used.",
      ].join("\n");
    case "live_execution_disabled":
      return [
        "⚪ Order not submitted on-chain",
        "",
        "Live trading is not enabled on the server.",
        "Your trade intent may still be recorded.",
      ].join("\n");
    case "stake_exceeds_user_max":
    case "stake_above_system_max":
    case "stake_below_system_min":
      return [
        "⚪ Stake not allowed",
        "",
        "The requested stake is outside your limits. Check /settings.",
        "No funds were used.",
      ].join("\n");
    case "user_max_open_positions":
    case "system_max_open_positions":
      return [
        "⚪ Position limit reached",
        "",
        "You already have the maximum number of open trades.",
        "Close or wait for positions to finish, or raise the limit in /settings.",
        "No funds were used.",
      ].join("\n");
    case "max_daily_loss":
    case "daily_loss_limit":
      return [
        "⚪ Daily loss limit reached",
        "",
        "No new trades until the next UTC day, or adjust /settings max daily loss.",
        "No funds were used.",
      ].join("\n");
    case "profit_target_reached":
    case "daily_profit_target":
      return [
        "⚪ Daily profit target reached",
        "",
        "New trades are paused until the next UTC day.",
        "No funds were used.",
      ].join("\n");
    case "insufficient_collateral":
    case "insufficient_balance":
      return [
        "⚪ Insufficient tUSDC",
        "",
        "Add funds with /faucet or check /status.",
        "No trade was placed.",
      ].join("\n");
    case "unauthenticated":
      return [
        "⚪ Wallet not ready",
        "",
        "Use /start first to create your wallet.",
      ].join("\n");
    case "persist_failed":
    case "missing_trade_id":
    case "stale_intent_cleanup_failed":
      return [
        "⚪ Could not record the trade",
        "",
        "Please try again in a moment. No on-chain order was sent.",
      ].join("\n");
    default:
      return [
        "⚪ No trade placed",
        "",
        "The trade could not be completed.",
        "No funds were used unless an on-chain transaction already confirmed.",
        "Check /status and try again, or use /help.",
      ].join("\n");
  }
}

/** Human label for execution mode (never show raw internal field names alone). */
export function formatExecutionModeLabel(mode: string): string {
  if (mode === "paper") return "paper (no on-chain orders)";
  if (mode === "testnet") return "testnet";
  return mode;
}

/**
 * Deterministic early-loss exit rule.
 * Clock starts at actual fill time. No AI. No market-creation clock.
 */

export const EARLY_EXIT_TIME_FRACTION = 0.5;
export const EARLY_EXIT_LOSS_FRACTION = 0.5;

export type EarlyExitPosition = {
  tradeId: string;
  marketId: string;
  direction: "up" | "down" | string;
  stake: number;
  filledContracts: number | null;
  entryPrice: number | null;
  filledAt: string | null;
  submittedAt: string | null;
  marketExpiry: string | number | null;
  intervalSec?: string | number | null;
  status: string;
};

export type EarlyExitEval =
  | {
      action: "exit";
      tradeId: string;
      marketId: string;
      reason: string;
      entryRemainingSeconds: number;
      elapsedSeconds: number;
      unrealizedLoss: number;
      markValue: number;
    }
  | { action: "hold"; tradeId: string; marketId: string; code: string; reason: string };

function unixSeconds(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && value.includes("T")) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

export function executionTimeSec(position: EarlyExitPosition): number | null {
  return unixSeconds(position.filledAt) ?? unixSeconds(position.submittedAt);
}

export function entryRemainingSeconds(position: EarlyExitPosition): number | null {
  const executed = executionTimeSec(position);
  const expiry = unixSeconds(position.marketExpiry);
  if (executed === null || expiry === null) return null;
  return Math.max(0, expiry - executed);
}

export function isOneMinuteWindow(intervalSec: string | number | null | undefined): boolean {
  if (intervalSec === null || intervalSec === undefined || intervalSec === "") return false;
  const n = Number(intervalSec);
  return Number.isFinite(n) && n > 0 && n <= 90;
}

export function markValueFromBid(input: {
  contracts: number;
  bid: number;
}): number | null {
  if (!(input.contracts > 0) || !(input.bid > 0) || input.bid >= 1) return null;
  return input.contracts * input.bid;
}

export function evaluateEarlyExit(input: {
  position: EarlyExitPosition;
  currentBid: number | null;
  nowSec?: number;
}): EarlyExitEval {
  const { position } = input;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);

  if (position.status !== "filled" && position.status !== "partially_filled") {
    return {
      action: "hold",
      tradeId: position.tradeId,
      marketId: position.marketId,
      code: "not_filled",
      reason: "Position is not a filled inventory row.",
    };
  }
  if (isOneMinuteWindow(position.intervalSec)) {
    return {
      action: "hold",
      tradeId: position.tradeId,
      marketId: position.marketId,
      code: "one_min_skipped",
      reason: "1m windows are not managed by early-loss exit.",
    };
  }

  const remaining = entryRemainingSeconds(position);
  const executed = executionTimeSec(position);
  if (remaining === null || executed === null) {
    return {
      action: "hold",
      tradeId: position.tradeId,
      marketId: position.marketId,
      code: "missing_execution_clock",
      reason: "filled_at/expiry missing; will not guess the 50% clock.",
    };
  }

  const elapsed = nowSec - executed;
  const timeOk = elapsed >= remaining * EARLY_EXIT_TIME_FRACTION;
  if (!timeOk) {
    return {
      action: "hold",
      tradeId: position.tradeId,
      marketId: position.marketId,
      code: "time_not_elapsed",
      reason: `Elapsed ${elapsed}s < 50% of entry remaining ${remaining}s.`,
    };
  }

  const contracts = position.filledContracts;
  if (contracts === null || !(contracts > 0)) {
    return {
      action: "hold",
      tradeId: position.tradeId,
      marketId: position.marketId,
      code: "no_inventory",
      reason: "No filled contract quantity to sell.",
    };
  }
  if (input.currentBid === null || !(input.currentBid > 0) || input.currentBid >= 1) {
    return {
      action: "hold",
      tradeId: position.tradeId,
      marketId: position.marketId,
      code: "no_bid",
      reason: "No usable opposite bid to mark or sell into.",
    };
  }

  const mark = markValueFromBid({ contracts, bid: input.currentBid });
  if (mark === null) {
    return {
      action: "hold",
      tradeId: position.tradeId,
      marketId: position.marketId,
      code: "no_mark",
      reason: "Could not mark position from bid.",
    };
  }
  const loss = position.stake - mark;
  const lossOk = loss + 1e-12 >= position.stake * EARLY_EXIT_LOSS_FRACTION;
  if (!lossOk) {
    return {
      action: "hold",
      tradeId: position.tradeId,
      marketId: position.marketId,
      code: "loss_below_threshold",
      reason: `Unrealized loss ${loss.toFixed(4)} < 50% of stake ${position.stake}.`,
    };
  }

  return {
    action: "exit",
    tradeId: position.tradeId,
    marketId: position.marketId,
    entryRemainingSeconds: remaining,
    elapsedSeconds: elapsed,
    unrealizedLoss: loss,
    markValue: mark,
    reason: `Early-loss exit: elapsed ${elapsed}s ≥ 50% of ${remaining}s remaining at fill, loss ${loss.toFixed(4)} ≥ 50% of stake ${position.stake}.`,
  };
}

export function yesLimitRawForSell(input: {
  direction: "up" | "down" | string;
  outcomeOwnBid: number;
  decimals: number;
}): bigint | null {
  const decimals = input.decimals;
  if (!(decimals >= 0) || !(input.outcomeOwnBid > 0) || input.outcomeOwnBid >= 1) return null;
  const scale = 10 ** decimals;
  const own = BigInt(Math.round(input.outcomeOwnBid * scale));
  const one = 10n ** BigInt(decimals);
  if (own <= 0n || own >= one) return null;
  const side = String(input.direction).toLowerCase();
  if (side === "up" || side === "yes") return own;
  return one - own;
}

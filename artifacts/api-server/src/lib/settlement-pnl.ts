/**
 * Pure settlement / PnL helpers for binary Event Contracts.
 *
 * Protocol (dreamDEX market lifecycle):
 * - status 4 Resolved → winning side redeems 1 tUSDC per contract
 * - status 5 Voided → both sides redeem 0.5 tUSDC per contract
 * - fee on dreamDEX settlement is 0
 *
 * Does not invent outcomes: requires explicit on-chain resolution evidence.
 */

export type BinaryDirection = "up" | "down";

export type MarketResolution =
  | { kind: "not_ready"; reason: string }
  | { kind: "voided" }
  | { kind: "resolved"; winner: BinaryDirection }
  | { kind: "unknown_resolved"; reason: string };

/** On-chain status enum from dreamDEX market structure docs. */
export const ONCHAIN_STATUS = {
  LISTED: 0,
  TRADING: 1,
  LOCKED: 2,
  SETTLING: 3,
  RESOLVED: 4,
  VOIDED: 5,
} as const;

/**
 * Map raw on-chain / indexer fields into a resolution verdict.
 * Never guesses YES/NO from price — only from explicit winner fields or void status.
 */
export function mapMarketResolution(input: {
  onchainStatus?: number | null;
  finalized?: boolean | null;
  indexerStatus?: string | null;
  /** 0/1, "yes"/"no", "up"/"down", or boolean for YES-won. */
  winningOutcome?: unknown;
  outcome?: unknown;
  result?: unknown;
  winner?: unknown;
}): MarketResolution {
  const status = input.onchainStatus;
  if (status === ONCHAIN_STATUS.VOIDED) {
    return { kind: "voided" };
  }

  if (status === ONCHAIN_STATUS.RESOLVED || input.finalized === true) {
    const winner = coerceWinner(
      input.winningOutcome ?? input.outcome ?? input.result ?? input.winner,
    );
    if (winner) return { kind: "resolved", winner };
    return {
      kind: "unknown_resolved",
      reason:
        "Market is resolved/finalized but winning side was not present in on-chain fields.",
    };
  }

  const indexer = (input.indexerStatus ?? "").toLowerCase();
  if (indexer === "voided" || indexer === "void") {
    return { kind: "voided" };
  }
  if (indexer === "finalized" || indexer === "resolved") {
    const winner = coerceWinner(
      input.winningOutcome ?? input.outcome ?? input.result ?? input.winner,
    );
    if (winner) return { kind: "resolved", winner };
    return {
      kind: "unknown_resolved",
      reason: "Indexer reports finalized without a parseable winning side.",
    };
  }

  if (
    status === ONCHAIN_STATUS.TRADING ||
    status === ONCHAIN_STATUS.LISTED ||
    status === ONCHAIN_STATUS.LOCKED ||
    status === ONCHAIN_STATUS.SETTLING ||
    status === null ||
    status === undefined
  ) {
    return {
      kind: "not_ready",
      reason: `Market status ${status ?? "unknown"} is not a terminal resolution.`,
    };
  }

  return {
    kind: "not_ready",
    reason: `Unrecognized on-chain status ${status}.`,
  };
}

function coerceWinner(raw: unknown): BinaryDirection | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "up" : "down";
  if (typeof raw === "number") {
    if (raw === 0) return "up";
    if (raw === 1) return "down";
    return null;
  }
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (["up", "yes", "long", "0"].includes(v)) return "up";
    if (["down", "no", "short", "1"].includes(v)) return "down";
    return null;
  }
  return null;
}

export type PnlComputation =
  | {
      ok: true;
      outcome: "up" | "down" | "void";
      payout: number;
      pnl: number;
      won: boolean | null;
    }
  | { ok: false; reason: string };

/**
 * Binary contract economics (dreamDEX): winner redeems 1 per contract; void 0.5.
 * Requires filled contract size for payout math; stake alone is not enough for wins.
 */
export function computeBinarySettlementPnl(input: {
  direction: string;
  stake: number;
  filledContracts: number | null;
  contracts?: number | null;
  resolution: MarketResolution;
}): PnlComputation {
  const direction = normalizeDirection(input.direction);
  if (!direction) {
    return { ok: false, reason: "Trade direction is not up/down." };
  }
  if (!Number.isFinite(input.stake) || input.stake <= 0) {
    return { ok: false, reason: "Stake is not a positive finite number." };
  }

  const size =
    input.filledContracts !== null &&
    input.filledContracts !== undefined &&
    Number.isFinite(input.filledContracts) &&
    input.filledContracts > 0
      ? input.filledContracts
      : input.contracts !== null &&
          input.contracts !== undefined &&
          Number.isFinite(input.contracts) &&
          input.contracts > 0
        ? input.contracts
        : null;

  if (input.resolution.kind === "not_ready") {
    return { ok: false, reason: input.resolution.reason };
  }
  if (input.resolution.kind === "unknown_resolved") {
    return { ok: false, reason: input.resolution.reason };
  }

  if (input.resolution.kind === "voided") {
    if (size === null) {
      return {
        ok: false,
        reason: "Voided market but contract size is unknown; cannot price 0.5 redeem.",
      };
    }
    const payout = size * 0.5;
    return {
      ok: true,
      outcome: "void",
      payout,
      pnl: payout - input.stake,
      won: null,
    };
  }

  // resolved
  const winner = input.resolution.winner;
  const won = direction === winner;
  if (size === null) {
    if (!won) {
      // Losing side pays zero regardless of size uncertainty once we know they lost.
      return {
        ok: true,
        outcome: winner,
        payout: 0,
        pnl: -input.stake,
        won: false,
      };
    }
    return {
      ok: false,
      reason: "Winning side needs filled contract size to compute 1:1 redeem payout.",
    };
  }

  const payout = won ? size : 0;
  return {
    ok: true,
    outcome: winner,
    payout,
    pnl: payout - input.stake,
    won,
  };
}

function normalizeDirection(raw: string): BinaryDirection | null {
  const v = raw.trim().toLowerCase();
  if (v === "up" || v === "yes") return "up";
  if (v === "down" || v === "no") return "down";
  return null;
}

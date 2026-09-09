/**
 * Deterministic 1-minute Binance vote.
 * Five usable prints → four signed moves vs the previous print.
 * Fail closed on missing/flat data. No ±0.05% trigger, no Groq.
 */

export const ONE_MIN_STRATEGY_NAME = "one-min-binance-vote-v1";
export const ONE_MIN_MIN_SECONDS_TO_EXPIRY = 30;
export const ONE_MIN_REQUIRED_PRINTS = 5;

export type OneMinDirection = "UP" | "DOWN";
export type OneMinMove = "UP" | "DOWN";

export type OneMinDecision =
  | {
      action: "enter";
      direction: OneMinDirection;
      prices: number[];
      moves: OneMinMove[];
      upCount: number;
      downCount: number;
      secondsToExpiry: number;
      reason: string;
    }
  | {
      action: "skip";
      reason: string;
      code: string;
      prices?: number[];
      secondsToExpiry?: number;
    };

export function usableBinancePrints(
  prices: ReadonlyArray<number | null | undefined>,
): number[] {
  const out: number[] = [];
  for (const price of prices) {
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      out.push(price);
    }
  }
  return out;
}

export function classifyAdjacentMoves(
  prices: readonly number[],
):
  | { ok: true; moves: OneMinMove[]; upCount: number; downCount: number }
  | { ok: false; code: string; reason: string } {
  if (prices.length < ONE_MIN_REQUIRED_PRINTS) {
    return {
      ok: false,
      code: "insufficient_prints",
      reason: `Need ${ONE_MIN_REQUIRED_PRINTS} usable Binance prints; have ${prices.length}.`,
    };
  }
  const window = prices.slice(-ONE_MIN_REQUIRED_PRINTS);
  const moves: OneMinMove[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const next = window[i]!;
    if (next > prev) moves.push("UP");
    else if (next < prev) moves.push("DOWN");
    else {
      return {
        ok: false,
        code: "flat_move",
        reason: `Print ${i} equals print ${i - 1} (${next}); cannot classify UP/DOWN. SKIP.`,
      };
    }
  }
  const upCount = moves.filter((m) => m === "UP").length;
  const downCount = moves.filter((m) => m === "DOWN").length;
  return { ok: true, moves, upCount, downCount };
}

export function voteOneMinuteDirection(
  upCount: number,
  downCount: number,
): OneMinDirection | "SKIP" {
  if (upCount === 4 && downCount === 0) return "DOWN";
  if (downCount === 4 && upCount === 0) return "UP";
  if (upCount === 3 && downCount === 1) return "UP";
  if (downCount === 3 && upCount === 1) return "DOWN";
  return "SKIP";
}

export function evaluateOneMinuteVote(input: {
  secondsToExpiry: number | null;
  prices: ReadonlyArray<number | null | undefined>;
}): OneMinDecision {
  const left = input.secondsToExpiry;
  if (left === null || !Number.isFinite(left)) {
    return {
      action: "skip",
      code: "bad_expiry",
      reason: "Could not parse seconds to expiry.",
    };
  }
  if (left <= 0) {
    return {
      action: "skip",
      code: "expired",
      reason: "Market already expired.",
      secondsToExpiry: left,
    };
  }
  if (left < ONE_MIN_MIN_SECONDS_TO_EXPIRY) {
    return {
      action: "skip",
      code: "too_close_to_expiry",
      reason: `1m requires at least ${ONE_MIN_MIN_SECONDS_TO_EXPIRY}s remaining (have ${Math.floor(left)}s).`,
      secondsToExpiry: left,
    };
  }

  const prints = usableBinancePrints(input.prices);
  const classified = classifyAdjacentMoves(prints);
  if (!classified.ok) {
    return {
      action: "skip",
      code: classified.code,
      reason: classified.reason,
      prices: prints.slice(-ONE_MIN_REQUIRED_PRINTS),
      secondsToExpiry: left,
    };
  }

  const direction = voteOneMinuteDirection(
    classified.upCount,
    classified.downCount,
  );
  const window = prints.slice(-ONE_MIN_REQUIRED_PRINTS);
  if (direction === "SKIP") {
    return {
      action: "skip",
      code: "tied_moves",
      reason: `Binance moves split ${classified.upCount} UP / ${classified.downCount} DOWN.`,
      prices: window,
      secondsToExpiry: left,
    };
  }

  const contrarian =
    (classified.upCount === 4 && direction === "DOWN") ||
    (classified.downCount === 4 && direction === "UP");
  return {
    action: "enter",
    direction,
    prices: window,
    moves: classified.moves,
    upCount: classified.upCount,
    downCount: classified.downCount,
    secondsToExpiry: left,
    reason: contrarian
      ? `Contrarian ${direction}: ${classified.upCount} UP / ${classified.downCount} DOWN across last ${ONE_MIN_REQUIRED_PRINTS} prints.`
      : `Follow ${direction}: ${classified.upCount} UP / ${classified.downCount} DOWN across last ${ONE_MIN_REQUIRED_PRINTS} prints.`,
  };
}

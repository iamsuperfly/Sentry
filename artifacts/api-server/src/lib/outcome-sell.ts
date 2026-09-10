/**
 * Complete-set / opposite-leg sell planning.
 * Never signs a zero or below-lot quantity. Does not invent contract calls.
 */

export type OutcomeSide = "YES" | "NO";

export type OutcomeSellPlan =
  | {
      ok: true;
      mode: "sell_held";
      sellSide: OutcomeSide;
      sellQuantity: number;
      mintQuantity: 0;
    }
  | {
      ok: true;
      mode: "mint_complete_set";
      sellSide: OutcomeSide;
      oppositeSide: OutcomeSide;
      sellQuantity: number;
      mintQuantity: number;
      heldQuantity: number;
    }
  | { ok: false; code: string; reason: string };

export function oppositeOutcome(side: OutcomeSide): OutcomeSide {
  return side === "YES" ? "NO" : "YES";
}

export function planOutcomeSell(input: {
  desiredSide: OutcomeSide;
  desiredQuantity: number;
  heldQuantity: number;
  snappedQuantity: number;
}): OutcomeSellPlan {
  const sellQuantity = input.snappedQuantity;
  if (!(sellQuantity > 0) || !Number.isFinite(sellQuantity)) {
    return {
      ok: false,
      code: "invalid_lot",
      reason: "Sell quantity snaps to zero; no order will be signed.",
    };
  }
  const held = Number.isFinite(input.heldQuantity) ? Math.max(0, input.heldQuantity) : 0;
  if (held + 1e-12 >= sellQuantity) {
    return {
      ok: true,
      mode: "sell_held",
      sellSide: input.desiredSide,
      sellQuantity,
      mintQuantity: 0,
    };
  }
  const mintQuantity = Math.round((sellQuantity - held) * 1e8) / 1e8;
  if (!(mintQuantity > 0)) {
    return {
      ok: false,
      code: "invalid_lot",
      reason: "Complete-set mint amount is zero; no order will be signed.",
    };
  }
  return {
    ok: true,
    mode: "mint_complete_set",
    sellSide: input.desiredSide,
    oppositeSide: oppositeOutcome(input.desiredSide),
    sellQuantity,
    mintQuantity,
    heldQuantity: held,
  };
}

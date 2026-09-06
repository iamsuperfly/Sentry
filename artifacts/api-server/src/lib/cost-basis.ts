/**
 * Realized cost basis for fills and early-exit sells.
 * Requested stake is only used when the fill is complete or size is unknown.
 */

export function realizedStakeBasis(input: {
  requestedStake: number;
  filledContracts: number | null | undefined;
  plannedContracts: number | null | undefined;
  limitPrice: number | null | undefined;
}): number {
  const stake = Number(input.requestedStake);
  if (!Number.isFinite(stake) || stake <= 0) return 0;

  const filled = Number(input.filledContracts);
  const planned = Number(input.plannedContracts);
  const price = Number(input.limitPrice);

  if (!Number.isFinite(filled) || filled <= 0) return stake;

  const complete =
    !Number.isFinite(planned) || planned <= 0 || filled + 1e-12 >= planned;
  if (complete) return stake;

  if (Number.isFinite(price) && price > 0 && price < 1) {
    return Math.round(Math.min(stake, filled * price) * 1e6) / 1e6;
  }
  return Math.round(stake * (filled / planned) * 1e6) / 1e6;
}

export function soldCostBasis(input: {
  positionStake: number;
  positionContracts: number;
  soldContracts: number;
}): number {
  if (!(input.positionContracts > 0) || !(input.soldContracts > 0)) return 0;
  const ratio = Math.min(1, input.soldContracts / input.positionContracts);
  return Math.round(input.positionStake * ratio * 1e6) / 1e6;
}

export type EarlyExitSplit = {
  soldContracts: number;
  soldStake: number;
  proceeds: number;
  pnl: number;
  remainingContracts: number;
  remainingStake: number;
  closedFully: boolean;
};

/** Split one inventory row into a realized sold slice and an optional remainder. */
export function splitEarlyExitInventory(input: {
  positionStake: number;
  positionContracts: number;
  soldContracts: number;
  proceeds: number;
}): EarlyExitSplit {
  const held = Math.max(0, input.positionContracts);
  const sold = Math.min(held, Math.max(0, input.soldContracts));
  const soldStake = soldCostBasis({
    positionStake: input.positionStake,
    positionContracts: held,
    soldContracts: sold,
  });
  const proceeds = Number.isFinite(input.proceeds) ? input.proceeds : 0;
  const pnl = Math.round((proceeds - soldStake) * 1e6) / 1e6;
  const remainingContracts = Math.round((held - sold) * 1e6) / 1e6;
  const remainingStake = Math.round((input.positionStake - soldStake) * 1e6) / 1e6;
  return {
    soldContracts: sold,
    soldStake,
    proceeds,
    pnl,
    remainingContracts: Math.max(0, remainingContracts),
    remainingStake: Math.max(0, remainingStake),
    closedFully: remainingContracts <= 1e-6,
  };
}

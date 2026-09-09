/**
 * Deterministic adaptive staking from entry price vs the 0.50 midpoint.
 * Not confidence. Not AI. Direction/market selection must already be decided.
 */

export const BINARY_FAIR_MIDPOINT = 0.5;

function floorStake(value: number): number {
  return Math.floor(value * 100) / 100;
}

/** Edge of the outcome being bought: 0.50 − entryPrice. */
export function entryPriceEdge(entryPrice: number): number | null {
  if (!Number.isFinite(entryPrice) || !(entryPrice > 0) || !(entryPrice < 1)) {
    return null;
  }
  return Math.round((BINARY_FAIR_MIDPOINT - entryPrice) * 1e10) / 1e10;
}

/**
 * Band input derived from edge. Equal to 1 − entryPrice.
 * Cheap asks raise this value; it is not a model confidence.
 */
export function stakeStrengthFromEdge(edge: number): number {
  return BINARY_FAIR_MIDPOINT + edge;
}

/**
 * Fraction of maxTradeStake.
 * <0.55 → 25%; 0.55–0.64 → 30%; 0.65–0.74 → 40%; 0.75–0.84 → 60%; ≥0.85 → 80%.
 */
export function stakeFractionFromStrength(strength: number): number {
  if (!Number.isFinite(strength)) return 0.25;
  if (strength < 0.55) return 0.25;
  if (strength < 0.65) return 0.3;
  if (strength < 0.75) return 0.4;
  if (strength < 0.85) return 0.6;
  return 0.8;
}

export function remainingDailyLossBudget(input: {
  realizedPnlToday: number;
  userMaxDailyLoss: number;
  systemMaxDailyLoss: number;
}): number {
  const pnl = Number.isFinite(input.realizedPnlToday)
    ? input.realizedPnlToday
    : 0;
  const lossUsed = Math.max(0, -pnl);
  const userLeft = Math.max(0, input.userMaxDailyLoss - lossUsed);
  const systemLeft = Math.max(0, input.systemMaxDailyLoss - lossUsed);
  return Math.min(userLeft, systemLeft);
}

export function executableAskNotional(input: {
  askPrice: number | null | undefined;
  askQuantityRaw?: string | number | null;
  decimals: number;
}): number | null {
  const price = input.askPrice;
  if (price === null || price === undefined || !(price > 0) || price >= 1) {
    return null;
  }
  const raw = input.askQuantityRaw;
  if (raw === null || raw === undefined || raw === "") return null;
  const scale = 10 ** input.decimals;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const qty = Number(raw) / scale;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const notional = qty * price;
  return Number.isFinite(notional) && notional > 0 ? notional : null;
}

export type AdaptiveStakeFromEntryInput = {
  entryPrice: number;
  maxTradeStake: number;
  systemMinStake: number;
  systemMaxStake: number;
  remainingBudget: number;
  collateralBalance?: number | null;
  askNotional?: number | null;
};

export type AdaptiveStakeFromEntryResult =
  | {
      ok: true;
      stake: number;
      edge: number;
      strength: number;
      fraction: number;
    }
  | { ok: false; code: string; reason: string };

export function sizeAdaptiveStakeFromEntry(
  input: AdaptiveStakeFromEntryInput,
): AdaptiveStakeFromEntryResult {
  const edge = entryPriceEdge(input.entryPrice);
  if (edge === null) {
    return {
      ok: false,
      code: "invalid_limit_price",
      reason: "Adaptive stake needs an entry price in (0, 1).",
    };
  }

  const strength = stakeStrengthFromEdge(edge);
  const fraction = stakeFractionFromStrength(strength);

  const cap = Math.min(
    input.maxTradeStake,
    input.systemMaxStake,
    input.remainingBudget,
    input.collateralBalance !== null &&
      input.collateralBalance !== undefined &&
      Number.isFinite(input.collateralBalance)
      ? input.collateralBalance
      : Number.POSITIVE_INFINITY,
    input.askNotional !== null &&
      input.askNotional !== undefined &&
      Number.isFinite(input.askNotional)
      ? input.askNotional
      : Number.POSITIVE_INFINITY,
  );

  if (!(cap > 0) || !Number.isFinite(cap)) {
    return {
      ok: false,
      code: "daily_budget_exhausted",
      reason: "Remaining daily-loss budget or collateral is too small for another stake.",
    };
  }

  let stake = input.maxTradeStake * fraction;
  stake = Math.min(stake, cap);
  stake = floorStake(stake);

  if (stake < input.systemMinStake) {
    return {
      ok: false,
      code: "stake_below_system_min",
      reason: `Sized stake ${stake} is below system min ${input.systemMinStake}.`,
    };
  }

  return { ok: true, stake, edge, strength, fraction };
}

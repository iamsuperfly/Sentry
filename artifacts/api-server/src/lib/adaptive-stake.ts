/**
 * Deterministic adaptive staking from entry price vs the 0.50 midpoint.
 * Not confidence. Not AI. Direction/market selection must already be decided.
 */

export const BINARY_FAIR_MIDPOINT = 0.5;

export type AdaptiveStakeBand = {
  /** Exclusive upper bound on strength. Null = remaining values (highest band). */
  maxStrength: number | null;
  fraction: number;
};

/**
 * System defaults — the live engine's existing bands.
 * Users inherit these until they save a custom list.
 */
export const DEFAULT_ADAPTIVE_STAKE_BANDS: readonly AdaptiveStakeBand[] = [
  { maxStrength: 0.55, fraction: 0.25 },
  { maxStrength: 0.65, fraction: 0.3 },
  { maxStrength: 0.75, fraction: 0.4 },
  { maxStrength: 0.85, fraction: 0.6 },
  { maxStrength: null, fraction: 0.8 },
];

export function cloneDefaultAdaptiveStakeBands(): AdaptiveStakeBand[] {
  return DEFAULT_ADAPTIVE_STAKE_BANDS.map((band) => ({ ...band }));
}

export function resolveAdaptiveStakeBands(
  custom: readonly AdaptiveStakeBand[] | null | undefined,
): AdaptiveStakeBand[] {
  if (!custom || custom.length === 0) return cloneDefaultAdaptiveStakeBands();
  return custom.map((band) => ({
    maxStrength: band.maxStrength,
    fraction: band.fraction,
  }));
}

export function parseAdaptiveStakeBands(
  raw: unknown,
): AdaptiveStakeBand[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const bands: AdaptiveStakeBand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const fraction = Number(row.fraction);
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return null;
    let maxStrength: number | null = null;
    if (row.maxStrength !== null && row.maxStrength !== undefined) {
      const n = Number(row.maxStrength);
      if (!Number.isFinite(n) || n <= 0) return null;
      maxStrength = n;
    }
    bands.push({ maxStrength, fraction });
  }
  const last = bands[bands.length - 1];
  if (!last || last.maxStrength !== null) return null;
  return bands;
}

export function validateAdaptiveStakeBands(
  bands: readonly AdaptiveStakeBand[],
): { ok: true } | { ok: false; code: string; reason: string } {
  if (!bands.length) {
    return { ok: false, code: "invalid_adaptive_bands", reason: "Adaptive bands cannot be empty." };
  }
  let previous = 0;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]!;
    if (!Number.isFinite(band.fraction) || band.fraction <= 0 || band.fraction > 1) {
      return {
        ok: false,
        code: "invalid_adaptive_bands",
        reason: "Each adaptive fraction must be in (0, 1].",
      };
    }
    const isLast = i === bands.length - 1;
    if (isLast) {
      if (band.maxStrength !== null) {
        return {
          ok: false,
          code: "invalid_adaptive_bands",
          reason: "The last adaptive band must be unbounded.",
        };
      }
      continue;
    }
    if (band.maxStrength === null || !(band.maxStrength > previous)) {
      return {
        ok: false,
        code: "invalid_adaptive_bands",
        reason: "Adaptive strength bounds must increase and the last band must be open.",
      };
    }
    previous = band.maxStrength;
  }
  return { ok: true };
}

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
 * Fraction of maxTradeStake using the supplied (or system-default) bands.
 */
export function stakeFractionFromStrength(
  strength: number,
  bands: readonly AdaptiveStakeBand[] | null | undefined = DEFAULT_ADAPTIVE_STAKE_BANDS,
): number {
  const resolved = resolveAdaptiveStakeBands(bands);
  if (!Number.isFinite(strength)) return resolved[0]?.fraction ?? 0.25;
  for (const band of resolved) {
    if (band.maxStrength === null || strength < band.maxStrength) {
      return band.fraction;
    }
  }
  return resolved[resolved.length - 1]?.fraction ?? 0.25;
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
  bands?: readonly AdaptiveStakeBand[] | null;
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
  const fraction = stakeFractionFromStrength(strength, input.bands);

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

/**
 * Deterministic stake sizing for AI (15m+) trades.
 * Groq stake is ignored. defaultStake is not the live size.
 */

export const CONFIDENCE_SKIP_BELOW = 0.55;

export function confidenceStakeFraction(
  confidence: number,
): number | null {
  if (!Number.isFinite(confidence) || confidence < CONFIDENCE_SKIP_BELOW) {
    return null;
  }
  if (confidence < 0.65) return 0.25;
  if (confidence < 0.75) return 0.4;
  if (confidence < 0.85) return 0.6;
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

function floorStake(value: number): number {
  return Math.floor(value * 100) / 100;
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

export type AdaptiveStakeInput = {
  confidence: number;
  maxTradeStake: number;
  systemMinStake: number;
  systemMaxStake: number;
  remainingBudget: number;
  askNotional: number | null;
};

export type AdaptiveStakeResult =
  | { ok: true; stake: number; fraction: number }
  | { ok: false; code: string; reason: string };

export function sizeAdaptiveStake(input: AdaptiveStakeInput): AdaptiveStakeResult {
  const fraction = confidenceStakeFraction(input.confidence);
  if (fraction === null) {
    return {
      ok: false,
      code: "confidence_below_band",
      reason: `Confidence ${input.confidence} is below ${CONFIDENCE_SKIP_BELOW}.`,
    };
  }

  const cap = Math.min(
    input.maxTradeStake,
    input.systemMaxStake,
    input.remainingBudget,
  );
  if (!(cap > 0) || !Number.isFinite(cap)) {
    return {
      ok: false,
      code: "daily_budget_exhausted",
      reason: "Remaining daily-loss budget is too small for another stake.",
    };
  }

  let stake = input.maxTradeStake * fraction;
  stake = Math.min(stake, cap);
  if (input.askNotional !== null) {
    if (!(input.askNotional > 0)) {
      return {
        ok: false,
        code: "insufficient_liquidity",
        reason: "No executable ask size on the book.",
      };
    }
    stake = Math.min(stake, input.askNotional);
  }

  stake = floorStake(stake);
  if (stake < input.systemMinStake) {
    return {
      ok: false,
      code: "stake_below_system_min",
      reason: `Sized stake ${stake} is below system min ${input.systemMinStake}.`,
    };
  }
  return { ok: true, stake, fraction };
}

export function sizeAdaptiveScan(input: {
  candidates: Array<{
    marketId: string;
    confidence: number;
    askNotional: number | null;
  }>;
  maxTradeStake: number;
  systemMinStake: number;
  systemMaxStake: number;
  remainingBudget: number;
}): Array<
  | { marketId: string; ok: true; stake: number; fraction: number }
  | { marketId: string; ok: false; code: string; reason: string }
> {
  let budget = input.remainingBudget;
  const out: Array<
    | { marketId: string; ok: true; stake: number; fraction: number }
    | { marketId: string; ok: false; code: string; reason: string }
  > = [];
  for (const c of input.candidates) {
    const sized = sizeAdaptiveStake({
      confidence: c.confidence,
      maxTradeStake: input.maxTradeStake,
      systemMinStake: input.systemMinStake,
      systemMaxStake: input.systemMaxStake,
      remainingBudget: budget,
      askNotional: c.askNotional,
    });
    if (!sized.ok) {
      out.push({ marketId: c.marketId, ...sized });
      continue;
    }
    budget = Math.max(0, floorStake(budget - sized.stake));
    out.push({ marketId: c.marketId, ...sized });
  }
  return out;
}

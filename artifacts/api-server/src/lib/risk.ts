/** Pure risk gates for Stage 3 — no I/O. */

export type UserRiskSettings = {
  tradingEnabled: boolean;
  defaultStake: number;
  maxTradeStake: number;
  maxDailyLoss: number;
  maxOpenPositions: number;
  /** Realized PnL for the current UTC day (negative = loss). */
  realizedPnlToday: number;
  openPositionCount: number;
  /** On-chain collateral balance available for the stake token (human units). */
  collateralBalance: number;
};

export type RiskInput = {
  stake: number;
  limitPrice: number;
  settings: UserRiskSettings;
};

export type RiskResult =
  | { ok: true; stake: number; contracts: number }
  | { ok: false; code: string; reason: string };

export function evaluateRisk(input: RiskInput): RiskResult {
  const { settings } = input;
  let stake = input.stake;

  if (!settings.tradingEnabled) {
    return {
      ok: false,
      code: "trading_disabled",
      reason: "User has trading_enabled=false.",
    };
  }

  if (!Number.isFinite(stake) || stake <= 0) {
    stake = settings.defaultStake;
  }

  if (stake > settings.maxTradeStake) {
    return {
      ok: false,
      code: "stake_exceeds_max",
      reason: `Stake ${stake} exceeds max_trade_stake ${settings.maxTradeStake}.`,
    };
  }

  if (settings.openPositionCount >= settings.maxOpenPositions) {
    return {
      ok: false,
      code: "max_open_positions",
      reason: `Open positions ${settings.openPositionCount} already at max ${settings.maxOpenPositions}.`,
    };
  }

  // realizedPnlToday negative means loss; stop when loss magnitude hits cap.
  if (settings.realizedPnlToday <= -settings.maxDailyLoss) {
    return {
      ok: false,
      code: "max_daily_loss",
      reason: `Daily loss limit reached (pnl=${settings.realizedPnlToday}, max_loss=${settings.maxDailyLoss}).`,
    };
  }

  if (settings.collateralBalance + 1e-12 < stake) {
    return {
      ok: false,
      code: "insufficient_collateral",
      reason: `Collateral balance ${settings.collateralBalance} is below stake ${stake}.`,
    };
  }

  if (
    !Number.isFinite(input.limitPrice) ||
    input.limitPrice <= 0 ||
    input.limitPrice >= 1
  ) {
    return {
      ok: false,
      code: "invalid_limit_price",
      reason: "limitPrice must be in (0, 1).",
    };
  }

  const contracts = stake / input.limitPrice;
  if (!Number.isFinite(contracts) || contracts <= 0) {
    return {
      ok: false,
      code: "invalid_contracts",
      reason: "Computed contract size is not positive.",
    };
  }

  return { ok: true, stake, contracts };
}

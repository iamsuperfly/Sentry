/**
 * Application risk layer (Stage 3).
 *
 * Layers (application only — protocol/tick/lot stay in future execution):
 * 1. System ceilings from env (SYSTEM_*_TUSDC)
 * 2. User preferences (must pass validateUserSettings)
 * 3. Runtime state (open count, realized PnL today, collateral)
 *
 * Shannon denomination: tUSDC human units. DB columns named *_usdso are legacy labels.
 */

import {
  DEFAULT_SYSTEM_LIMITS,
  type SystemRiskLimits,
} from "./system-limits.ts";

export type UserRiskPreferences = {
  tradingEnabled: boolean;
  defaultStake: number;
  maxTradeStake: number;
  maxDailyLoss: number;
  maxOpenPositions: number;
  /** Null/undefined = disabled. Positive = stop new trades when realized PnL >= target. */
  dailyProfitTarget: number | null;
};

/** Runtime inputs that are not user-editable preferences. */
export type RiskRuntimeState = {
  /** Realized PnL for the current UTC day (negative = loss). From trades when available. */
  realizedPnlToday: number;
  openPositionCount: number;
  /** Wallet tUSDC balance (human). */
  collateralBalance: number;
};

export type UserRiskSettings = UserRiskPreferences & RiskRuntimeState;

export type RiskInput = {
  /** Requested stake; if missing/invalid, falls back to user defaultStake. */
  stake?: number;
  limitPrice: number;
  settings: UserRiskSettings;
  system: SystemRiskLimits;
};

export type RiskResult =
  | { ok: true; stake: number; contracts: number }
  | { ok: false; code: string; reason: string };

export type SettingsValidationResult =
  | { ok: true; settings: UserRiskPreferences }
  | { ok: false; code: string; reason: string };

/**
 * Validate user-editable risk preferences against system ceilings.
 * Explicit rejection — never silently clamps requested values.
 */
export function validateUserSettings(
  prefs: UserRiskPreferences,
  system: SystemRiskLimits = DEFAULT_SYSTEM_LIMITS,
): SettingsValidationResult {
  const {
    defaultStake,
    maxTradeStake,
    maxDailyLoss,
    maxOpenPositions,
    dailyProfitTarget,
  } = prefs;

  if (!Number.isFinite(defaultStake) || !Number.isFinite(maxTradeStake)) {
    return {
      ok: false,
      code: "invalid_stake_prefs",
      reason: "default_stake and max_trade_stake must be finite numbers.",
    };
  }

  if (defaultStake < system.minStake) {
    return {
      ok: false,
      code: "default_stake_below_system_min",
      reason: `default_stake ${defaultStake} is below SYSTEM_MIN_STAKE_TUSDC ${system.minStake}.`,
    };
  }

  if (maxTradeStake > system.maxStake) {
    return {
      ok: false,
      code: "max_trade_stake_above_system_max",
      reason: `max_trade_stake ${maxTradeStake} exceeds SYSTEM_MAX_STAKE_TUSDC ${system.maxStake}.`,
    };
  }

  if (defaultStake > maxTradeStake) {
    return {
      ok: false,
      code: "default_above_user_max",
      reason: `default_stake ${defaultStake} cannot exceed max_trade_stake ${maxTradeStake}.`,
    };
  }

  if (!Number.isFinite(maxDailyLoss) || maxDailyLoss < system.minStake) {
    return {
      ok: false,
      code: "invalid_max_daily_loss",
      reason: `max_daily_loss must be finite and ≥ ${system.minStake}.`,
    };
  }

  if (maxDailyLoss > system.maxDailyLoss) {
    return {
      ok: false,
      code: "max_daily_loss_above_system_max",
      reason: `max_daily_loss ${maxDailyLoss} exceeds SYSTEM_MAX_DAILY_LOSS_TUSDC ${system.maxDailyLoss}.`,
    };
  }

  if (
    !Number.isInteger(maxOpenPositions) ||
    maxOpenPositions < 1 ||
    maxOpenPositions > system.maxOpenPositions
  ) {
    return {
      ok: false,
      code: "invalid_max_open_positions",
      reason: `max_open_positions must be an integer in [1, ${system.maxOpenPositions}].`,
    };
  }

  if (dailyProfitTarget !== null && dailyProfitTarget !== undefined) {
    if (!Number.isFinite(dailyProfitTarget) || dailyProfitTarget <= 0) {
      return {
        ok: false,
        code: "invalid_daily_profit_target",
        reason: "daily_profit_target must be null (disabled) or a positive number.",
      };
    }
  }

  return {
    ok: true,
    settings: {
      tradingEnabled: prefs.tradingEnabled,
      defaultStake,
      maxTradeStake,
      maxDailyLoss,
      maxOpenPositions,
      dailyProfitTarget:
        dailyProfitTarget === undefined ? null : dailyProfitTarget,
    },
  };
}

/**
 * Evaluate whether a proposed stake is allowed given system + user + runtime state.
 * Does not perform protocol tick/lot checks (execution layer).
 */
export function evaluateRisk(input: RiskInput): RiskResult {
  const { settings, system } = input;

  if (!settings.tradingEnabled) {
    return {
      ok: false,
      code: "trading_disabled",
      reason: "User has trading_enabled=false.",
    };
  }

  // Prefer explicit rejection of invalid stored prefs over silent repair.
  const prefsCheck = validateUserSettings(settings, system);
  if (!prefsCheck.ok) {
    return { ok: false, code: prefsCheck.code, reason: prefsCheck.reason };
  }

  let stake =
    input.stake !== undefined && Number.isFinite(input.stake) && input.stake > 0
      ? input.stake
      : settings.defaultStake;

  if (stake < system.minStake) {
    return {
      ok: false,
      code: "stake_below_system_min",
      reason: `Stake ${stake} is below SYSTEM_MIN_STAKE_TUSDC ${system.minStake}.`,
    };
  }

  if (stake > system.maxStake) {
    return {
      ok: false,
      code: "stake_above_system_max",
      reason: `Stake ${stake} exceeds SYSTEM_MAX_STAKE_TUSDC ${system.maxStake}.`,
    };
  }

  if (stake > settings.maxTradeStake) {
    return {
      ok: false,
      code: "stake_exceeds_user_max",
      reason: `Stake ${stake} exceeds user max_trade_stake ${settings.maxTradeStake}.`,
    };
  }

  if (settings.openPositionCount >= system.maxOpenPositions) {
    return {
      ok: false,
      code: "system_max_open_positions",
      reason: `Open positions ${settings.openPositionCount} already at SYSTEM_MAX_OPEN_POSITIONS ${system.maxOpenPositions}.`,
    };
  }

  if (settings.openPositionCount >= settings.maxOpenPositions) {
    return {
      ok: false,
      code: "user_max_open_positions",
      reason: `Open positions ${settings.openPositionCount} already at user max_open_positions ${settings.maxOpenPositions}.`,
    };
  }

  // Daily loss stop: realized PnL ≤ -user.maxDailyLoss (and user limit ≤ system).
  if (settings.realizedPnlToday <= -settings.maxDailyLoss) {
    return {
      ok: false,
      code: "user_daily_loss_stop",
      reason: `Daily loss stop reached (pnl=${settings.realizedPnlToday}, limit=${settings.maxDailyLoss}). Resets next UTC day.`,
    };
  }

  if (settings.realizedPnlToday <= -system.maxDailyLoss) {
    return {
      ok: false,
      code: "system_daily_loss_stop",
      reason: `System daily loss ceiling reached (pnl=${settings.realizedPnlToday}, SYSTEM_MAX_DAILY_LOSS_TUSDC=${system.maxDailyLoss}).`,
    };
  }

  const target = settings.dailyProfitTarget;
  if (
    target !== null &&
    target !== undefined &&
    settings.realizedPnlToday >= target
  ) {
    return {
      ok: false,
      code: "daily_profit_target_reached",
      reason: `Daily profit target ${target} reached (pnl=${settings.realizedPnlToday}). Resets next UTC day.`,
    };
  }

  if (settings.collateralBalance + 1e-12 < stake) {
    return {
      ok: false,
      code: "insufficient_collateral",
      reason: `tUSDC balance ${settings.collateralBalance} is below stake ${stake}.`,
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

/** Documented initial user defaults (not system ceilings). */
export const DEFAULT_USER_PREFERENCES: UserRiskPreferences = {
  tradingEnabled: false,
  defaultStake: 1,
  maxTradeStake: 1,
  maxDailyLoss: 10,
  maxOpenPositions: 1,
  dailyProfitTarget: null,
};

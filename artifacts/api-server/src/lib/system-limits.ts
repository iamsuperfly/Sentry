/**
 * Bot/system safety ceilings for Stage 3.
 * These are application policy, NOT DreamDEX protocol requirements.
 * Stake/loss units on Shannon = tUSDC human amounts.
 */

export type SystemRiskLimits = {
  minStake: number;
  maxStake: number;
  maxOpenPositions: number;
  maxDailyLoss: number;
};

/** Fixed product defaults when env is unset. */
export const DEFAULT_SYSTEM_LIMITS: SystemRiskLimits = {
  minStake: 1,
  maxStake: 200,
  maxOpenPositions: 10,
  maxDailyLoss: 300,
};

export function parsePositiveNumber(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function resolveSystemLimits(env: {
  SYSTEM_MIN_STAKE_TUSDC?: string;
  SYSTEM_MAX_STAKE_TUSDC?: string;
  SYSTEM_MAX_OPEN_POSITIONS?: string;
  SYSTEM_MAX_DAILY_LOSS_TUSDC?: string;
}): SystemRiskLimits {
  const minStake = parsePositiveNumber(
    env.SYSTEM_MIN_STAKE_TUSDC,
    DEFAULT_SYSTEM_LIMITS.minStake,
  );
  let maxStake = parsePositiveNumber(
    env.SYSTEM_MAX_STAKE_TUSDC,
    DEFAULT_SYSTEM_LIMITS.maxStake,
  );
  if (maxStake < minStake) maxStake = minStake;

  let maxOpenPositions = Math.floor(
    parsePositiveNumber(
      env.SYSTEM_MAX_OPEN_POSITIONS,
      DEFAULT_SYSTEM_LIMITS.maxOpenPositions,
    ),
  );
  if (maxOpenPositions < 1) maxOpenPositions = 1;

  let maxDailyLoss = parsePositiveNumber(
    env.SYSTEM_MAX_DAILY_LOSS_TUSDC,
    DEFAULT_SYSTEM_LIMITS.maxDailyLoss,
  );
  if (maxDailyLoss < minStake) maxDailyLoss = minStake;

  return { minStake, maxStake, maxOpenPositions, maxDailyLoss };
}

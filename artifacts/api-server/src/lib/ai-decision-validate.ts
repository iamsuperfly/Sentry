/**
 * Deterministic validation of Gemini (or any AI) trade candidates.
 * Risk ceilings remain authoritative.
 */

export type ScannedMarketRef = {
  marketId: string;
  tradable: boolean;
  finalized: boolean;
  secondsToExpiry: number | null;
  asset: string;
};

export type AiCandidate = {
  marketId: string;
  direction: "UP" | "DOWN" | string;
  confidence: number;
  reason: string;
  stake: number | null;
};

export type ValidationContext = {
  markets: ScannedMarketRef[];
  availableSlots: number;
  systemMinStake: number;
  systemMaxStake: number;
  userMaxStake: number;
  defaultStake: number;
};

export type ValidatedCandidate = {
  marketId: string;
  direction: "UP" | "DOWN";
  confidence: number;
  reason: string;
  stake: number;
};

export type ValidationResult = {
  accepted: ValidatedCandidate[];
  rejected: Array<{ marketId: string; code: string; reason: string }>;
};

export function validateAiCandidates(
  candidates: AiCandidate[],
  ctx: ValidationContext,
): ValidationResult {
  const byId = new Map(ctx.markets.map((m) => [m.marketId, m]));
  const accepted: ValidatedCandidate[] = [];
  const rejected: Array<{ marketId: string; code: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    if (accepted.length >= ctx.availableSlots) {
      rejected.push({
        marketId: c.marketId,
        code: "slots_full",
        reason: `Already accepted ${ctx.availableSlots} candidates (available slots).`,
      });
      continue;
    }
    if (!c.marketId || !byId.has(c.marketId)) {
      rejected.push({
        marketId: c.marketId || "(empty)",
        code: "unknown_market",
        reason: "marketId not present in this scan snapshot.",
      });
      continue;
    }
    if (seen.has(c.marketId)) {
      rejected.push({
        marketId: c.marketId,
        code: "duplicate_market",
        reason: "Duplicate marketId in AI response.",
      });
      continue;
    }
    const m = byId.get(c.marketId)!;
    if (m.finalized || !m.tradable) {
      rejected.push({
        marketId: c.marketId,
        code: "not_tradable",
        reason: "Market is not tradable in this snapshot.",
      });
      continue;
    }
    if (m.secondsToExpiry !== null && m.secondsToExpiry <= 0) {
      rejected.push({
        marketId: c.marketId,
        code: "expired",
        reason: "Market expiry is in the past.",
      });
      continue;
    }
    const dir = String(c.direction).toUpperCase();
    if (dir !== "UP" && dir !== "DOWN") {
      rejected.push({
        marketId: c.marketId,
        code: "invalid_direction",
        reason: `Direction ${c.direction} is not UP/DOWN.`,
      });
      continue;
    }

    let stake =
      c.stake !== null && c.stake !== undefined && Number.isFinite(c.stake) && c.stake > 0
        ? c.stake
        : ctx.defaultStake;

    if (stake < ctx.systemMinStake) {
      rejected.push({
        marketId: c.marketId,
        code: "stake_below_min",
        reason: `Stake ${stake} below system min ${ctx.systemMinStake}.`,
      });
      continue;
    }
    if (stake > ctx.systemMaxStake) {
      rejected.push({
        marketId: c.marketId,
        code: "stake_above_system_max",
        reason: `Stake ${stake} exceeds system max ${ctx.systemMaxStake}.`,
      });
      continue;
    }
    if (stake > ctx.userMaxStake) {
      rejected.push({
        marketId: c.marketId,
        code: "stake_above_user_max",
        reason: `Stake ${stake} exceeds user max stake ${ctx.userMaxStake}.`,
      });
      continue;
    }

    seen.add(c.marketId);
    accepted.push({
      marketId: c.marketId,
      direction: dir as "UP" | "DOWN",
      confidence: c.confidence,
      reason: c.reason,
      stake,
    });
  }

  return { accepted, rejected };
}

export function computeAvailableSlots(input: {
  userMaxOpenPositions: number;
  systemMaxOpenPositions: number;
  currentOpenPositions: number;
}): number {
  const cap = Math.min(input.userMaxOpenPositions, input.systemMaxOpenPositions);
  return Math.max(0, cap - input.currentOpenPositions);
}

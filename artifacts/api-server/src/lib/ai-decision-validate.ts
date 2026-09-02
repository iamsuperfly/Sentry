/**
 * Deterministic validation of Gemini (or any AI) trade candidates.
 * Risk ceilings remain authoritative.
 * Live stake is assigned by adaptive-stake, not Groq.
 */

import { executableAskNotional, sizeAdaptiveScan } from "./adaptive-stake.ts";

export type ScannedMarketRef = {
  marketId: string;
  tradable: boolean;
  finalized: boolean;
  secondsToExpiry: number | null;
  asset: string;
  decimals?: number;
  yesAsk?: number | null;
  noAsk?: number | null;
  yesAskQuantity?: string | null;
  noAskQuantity?: string | null;
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
  remainingBudget?: number;
  maxTradeStake?: number;
  askNotionalByMarket?: Record<string, number | null>;
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

    seen.add(c.marketId);
    accepted.push({
      marketId: c.marketId,
      direction: dir as "UP" | "DOWN",
      confidence: c.confidence,
      reason: c.reason,
      stake: 0,
    });
  }

  const maxTradeStake = ctx.maxTradeStake;
  const remainingBudget = ctx.remainingBudget;
  if (
    accepted.length > 0 &&
    maxTradeStake !== undefined &&
    remainingBudget !== undefined
  ) {
    const ranked = [...accepted].sort((a, b) => b.confidence - a.confidence);
    const sized = sizeAdaptiveScan({
      candidates: ranked.map((c) => {
        const m = byId.get(c.marketId);
        const ask = c.direction === "UP" ? m?.yesAsk : m?.noAsk;
        const qty = c.direction === "UP" ? m?.yesAskQuantity : m?.noAskQuantity;
        return {
          marketId: c.marketId,
          confidence: c.confidence,
          askNotional: executableAskNotional({
            askPrice: ask ?? null,
            askQuantityRaw: qty ?? null,
            decimals: m?.decimals ?? 6,
          }),
        };
      }),
      maxTradeStake,
      systemMinStake: ctx.systemMinStake,
      systemMaxStake: ctx.systemMaxStake,
      remainingBudget,
    });
    const next: ValidatedCandidate[] = [];
    for (const row of sized) {
      const orig = ranked.find((c) => c.marketId === row.marketId);
      if (!orig) continue;
      if (!row.ok) {
        rejected.push({
          marketId: row.marketId,
          code: row.code,
          reason: row.reason,
        });
        continue;
      }
      next.push({ ...orig, stake: row.stake });
    }
    return { accepted: next, rejected };
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

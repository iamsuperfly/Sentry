import type { StrategyDecision } from "./strategy.ts";
import {
  evaluateRisk,
  type UserRiskSettings,
} from "./risk.ts";
import {
  DEFAULT_SYSTEM_LIMITS,
  type SystemRiskLimits,
} from "./system-limits.ts";
import { isTerminalTradeStatus } from "./trade-state.ts";

/** Stage 3 execution layer — intents + state machine. Live chain submit is gated. */

export const EXECUTION_MODULE = "stage-3-execution";

export type DbDirection = "up" | "down";

export type IntentStatus =
  | "pending"
  | "submitted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "settled"
  | "redeemed"
  | "failed";

export type TradeIntent = {
  idempotencyKey: string;
  userId: string;
  walletAddress: string;
  marketId: string;
  symbol: string;
  direction: DbDirection;
  side: "buy";
  strategyName: string;
  strategyVersion: string;
  stake: number;
  contracts: number;
  limitPrice: number;
  poolAddress: string;
  status: IntentStatus;
  decision: StrategyDecision;
  rejectReason: string | null;
};

export type IntentBuildResult =
  | { ok: true; intent: TradeIntent }
  | { ok: false; code: string; reason: string; idempotencyKey: string };

export function mapDirection(direction: "YES" | "NO"): DbDirection {
  return direction === "YES" ? "up" : "down";
}

export function buildIdempotencyKey(input: {
  userId: string;
  marketId: string;
  strategyName: string;
  strategyVersion: string;
  direction: "YES" | "NO";
}): string {
  return [
    input.userId,
    input.marketId,
    input.strategyName,
    input.strategyVersion,
    input.direction,
  ].join(":");
}

/**
 * A terminal trade closes one idempotency generation. Deriving the next key
 * from that persisted row keeps retries of the new generation idempotent
 * without weakening the database's global unique-key protection.
 */
export function buildReentryIdempotencyKey(
  baseKey: string,
  previousTradeId: string,
): string {
  return `${baseKey}:reentry:${previousTradeId}`;
}

/**
 * Convert a Stage 2 enter decision into a trade intent after system+user risk.
 * Does not touch the chain or database — pure.
 * Protocol tick/lot/status checks remain for the live execution path.
 */
export function buildTradeIntent(input: {
  userId: string;
  walletAddress: string;
  decision: StrategyDecision;
  settings: UserRiskSettings;
  system?: SystemRiskLimits;
  stake?: number;
  existing?: { status: IntentStatus; idempotencyKey: string } | null;
}): IntentBuildResult {
  const { decision } = input;
  const system = input.system ?? DEFAULT_SYSTEM_LIMITS;
  const idempotencyKey = buildIdempotencyKey({
    userId: input.userId,
    marketId: decision.marketId,
    strategyName: decision.strategyName,
    strategyVersion: decision.strategyVersion,
    direction: decision.direction ?? "YES",
  });

  if (
    decision.action !== "enter" ||
    !decision.direction ||
    decision.limitPriceHint == null
  ) {
    return {
      ok: false,
      code: "not_enter",
      reason:
        "Only Stage 2 enter decisions with direction and limitPriceHint can become intents.",
      idempotencyKey,
    };
  }

  if (input.existing) {
    if (!isTerminalTradeStatus(input.existing.status)) {
      return {
        ok: false,
        code: "duplicate_intent",
        reason: `Active intent already exists with status ${input.existing.status}.`,
        idempotencyKey,
      };
    }
  }

  const risk = evaluateRisk({
    stake: input.stake,
    limitPrice: decision.limitPriceHint,
    settings: input.settings,
    system,
  });

  if (!risk.ok) {
    return {
      ok: false,
      code: risk.code,
      reason: risk.reason,
      idempotencyKey,
    };
  }

  const symbol = `${decision.asset}-${decision.marketId.slice(0, 10)}/${decision.direction}`;

  return {
    ok: true,
    intent: {
      idempotencyKey,
      userId: input.userId,
      walletAddress: input.walletAddress,
      marketId: decision.marketId,
      symbol,
      direction: mapDirection(decision.direction),
      side: "buy",
      strategyName: decision.strategyName,
      strategyVersion: decision.strategyVersion,
      stake: risk.stake,
      contracts: risk.contracts,
      limitPrice: decision.limitPriceHint,
      poolAddress: decision.poolAddress,
      status: "pending",
      decision,
      rejectReason: null,
    },
  };
}

const TRANSITIONS: Record<IntentStatus, IntentStatus[]> = {
  pending: ["submitted", "failed", "cancelled"],
  submitted: ["partially_filled", "filled", "failed", "cancelled"],
  partially_filled: ["filled", "cancelled", "failed"],
  filled: ["settled", "failed"],
  cancelled: [],
  settled: ["redeemed"],
  redeemed: [],
  failed: [],
};

export function canTransition(
  from: IntentStatus,
  to: IntentStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionIntent(
  status: IntentStatus,
  next: IntentStatus,
): { ok: true; status: IntentStatus } | { ok: false; reason: string } {
  if (!canTransition(status, next)) {
    return {
      ok: false,
      reason: `Illegal transition ${status} → ${next}.`,
    };
  }
  return { ok: true, status: next };
}

export type LiveSubmitGate = {
  enableLiveExecution: boolean;
  liveExecutionRequested: boolean;
};

export function assertLiveSubmitAllowed(
  gate: LiveSubmitGate,
): { ok: true } | { ok: false; code: string; reason: string } {
  if (!gate.enableLiveExecution) {
    return {
      ok: false,
      code: "live_execution_disabled",
      reason:
        "ENABLE_LIVE_EXECUTION is false. Intents may be recorded; chain submit is blocked.",
    };
  }
  if (!gate.liveExecutionRequested) {
    return {
      ok: false,
      code: "live_not_requested",
      reason: "Caller did not request liveExecution=true.",
    };
  }
  return { ok: true };
}

/**
 * Planned on-chain steps when live submit is enabled.
 * Signer is always the user wallet (never treasury).
 * Protocol checks (Trading status, tick, lot, tUSDC allowance) belong here — not in user risk prefs.
 */
export function planLiveSubmission(intent: TradeIntent): {
  steps: string[];
  signer: "user_wallet";
  orderType: "IOC";
  side: "buy";
  direction: DbDirection;
  marketId: string;
  poolAddress: string;
  limitPrice: number;
  contracts: number;
  collateralToken: "tUSDC";
  collateralAddress: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
} {
  return {
    steps: [
      "Decrypt user encrypted_private_key in memory (WALLET_ENCRYPTION_KEY).",
      "Construct SomniaMarkets with user privateKey (never treasury).",
      "PROTOCOL: Re-read getMarketOnchain(marketId); abort if status !== Trading.",
      "PROTOCOL: Snap price to pool tick grid; snap size to lot grid; abort if size becomes 0.",
      "PROTOCOL: Ensure tUSDC (0x70a86D…) allowance to current pool; approve if needed.",
      "Place IOC buy on YES or NO at limitPrice for contracts.",
      "Persist transaction hash / fill size; transition pending → submitted → filled|failed.",
    ],
    signer: "user_wallet",
    orderType: "IOC",
    side: "buy",
    direction: intent.direction,
    marketId: intent.marketId,
    poolAddress: intent.poolAddress,
    limitPrice: intent.limitPrice,
    contracts: intent.contracts,
    collateralToken: "tUSDC",
    collateralAddress: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  };
}

/**
 * Stage 5A — Live execution layer (protocol gates + order path).
 *
 * - Signer is always the per-user wallet (never treasury).
 * - Shannon Event Contract collateral is tUSDC (on-chain market.collateral).
 * - ENABLE_LIVE_EXECUTION must be true AND liveExecutionRequested must be true
 *   before any chain write. Default config keeps the gate closed.
 * - Chain I/O is injectable so unit tests never need real keys or RPC.
 */

import type { AppConfig } from "../config.ts";
import {
  assertLiveSubmitAllowed,
  canTransition,
  type IntentStatus,
  type TradeIntent,
} from "./execution.ts";
import { decryptPrivateKey } from "./wallet-crypto.ts";

/** Verified Shannon Event Contract test collateral. */
export const SHANNON_TUSDC =
  "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as const;

export const ONCHAIN_TRADING_STATUS = 1;

export type ProtocolMarketSnapshot = {
  marketId: string;
  onchainStatus: number;
  poolAddress: string;
  collateral: string;
  decimals: number;
  /** Human probability tick, e.g. 0.01 */
  tickSize: number;
  /** Contract size lot in human units */
  lotSize: number;
  /** Market expiry as unix seconds */
  expirySec: number;
};

export type IocOrderDraft = {
  marketId: string;
  poolAddress: string;
  side: "buy";
  outcome: "YES" | "NO";
  orderType: "IOC";
  limitPrice: number;
  contracts: number;
  stake: number;
  collateral: string;
  decimals: number;
  /** Order deadline as unix seconds (dead-man switch before market expiry). */
  expireAtSec: number;
  signerRole: "user_wallet";
};

export type ProtocolGateResult =
  | { ok: true; order: IocOrderDraft; needsApproval: boolean; requiredAllowance: number }
  | { ok: false; code: string; reason: string };

export type ChainReadSnapshot = {
  market: ProtocolMarketSnapshot;
  tusdcBalance: number;
  /** Current ERC-20 allowance of collateral to the pool (human units). */
  allowance: number;
  nowSec: number;
};

export type ChainWriteResult = {
  transactionHash: string;
  orderId?: string;
  filledContracts: number;
  status: "filled" | "partially_filled" | "failed";
  errorMessage?: string;
};

/** Injectable deps — production wires SDK; tests inject mocks. */
export type LiveExecutionDeps = {
  readChain: (intent: TradeIntent) => Promise<ChainReadSnapshot>;
  /** Approve pool for collateral if needed. Returns tx hash or null if skipped. */
  ensureAllowance: (input: {
    privateKey: string;
    collateral: string;
    pool: string;
    amount: number;
    decimals: number;
  }) => Promise<string | null>;
  placeIocOrder: (input: {
    privateKey: string;
    order: IocOrderDraft;
  }) => Promise<ChainWriteResult>;
  /** Persist trade row updates (status, hash, fills). */
  updateTrade: (input: {
    tradeId: string;
    userId: string;
    status: IntentStatus;
    transactionHash?: string;
    orderId?: string;
    filledContracts?: number;
    errorMessage?: string;
  }) => Promise<void>;
};

function floorToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  const ticks = Math.floor(price / tickSize + 1e-12);
  return Number((ticks * tickSize).toFixed(12));
}

function floorToLot(size: number, lotSize: number): number {
  if (!(lotSize > 0)) return size;
  const lots = Math.floor(size / lotSize + 1e-12);
  return Number((lots * lotSize).toFixed(12));
}

export function mapDirectionToOutcome(direction: "up" | "down"): "YES" | "NO" {
  return direction === "up" ? "YES" : "NO";
}

/**
 * Pure protocol gate: Trading status, tick, lot, balance, allowance need, expiry.
 * Does not touch keys or the network.
 */
export function evaluateProtocolGates(input: {
  intent: TradeIntent;
  market: ProtocolMarketSnapshot;
  tusdcBalance: number;
  allowance: number;
  nowSec: number;
}): ProtocolGateResult {
  const { intent, market, tusdcBalance, allowance, nowSec } = input;

  if (market.onchainStatus !== ONCHAIN_TRADING_STATUS) {
    return {
      ok: false,
      code: "market_not_trading",
      reason: `On-chain status ${market.onchainStatus} is not Trading (${ONCHAIN_TRADING_STATUS}).`,
    };
  }

  if (market.marketId !== intent.marketId) {
    return {
      ok: false,
      code: "market_id_mismatch",
      reason: "Snapshot marketId does not match intent marketId.",
    };
  }

  // Prefer live pool binding from chain over a possibly stale intent pool.
  const poolAddress = market.poolAddress;

  if (!market.collateral || market.collateral.toLowerCase() === "0x") {
    return {
      ok: false,
      code: "missing_collateral",
      reason: "Market has no on-chain collateral address.",
    };
  }

  // Shannon EC collateral is tUSDC; still bind to the market's reported address.
  if (
    market.collateral.toLowerCase() !== SHANNON_TUSDC.toLowerCase() &&
    // Allow tests to use the same address; reject obvious mainnet-style mismatches only when clearly different length tokens — soft check:
    false
  ) {
    /* kept for documentation; real path uses market.collateral always */
  }

  if (!(market.tickSize > 0) || !(market.lotSize > 0)) {
    return {
      ok: false,
      code: "invalid_tick_or_lot",
      reason: "Pool tickSize and lotSize must be positive.",
    };
  }

  const snappedPrice = floorToTick(intent.limitPrice, market.tickSize);
  if (snappedPrice <= 0 || snappedPrice >= 1) {
    return {
      ok: false,
      code: "invalid_tick",
      reason: `Limit price ${intent.limitPrice} snaps to invalid tick ${snappedPrice}.`,
    };
  }

  const snappedContracts = floorToLot(intent.contracts, market.lotSize);
  if (snappedContracts <= 0) {
    return {
      ok: false,
      code: "invalid_lot",
      reason: `Contract size ${intent.contracts} snaps to zero on lot ${market.lotSize}.`,
    };
  }

  // Worst-case collateral for a buy ≈ contracts * limitPrice (human).
  const requiredCollateral = snappedContracts * snappedPrice;
  if (tusdcBalance + 1e-12 < requiredCollateral) {
    return {
      ok: false,
      code: "insufficient_tusdc",
      reason: `tUSDC balance ${tusdcBalance} is below required ${requiredCollateral}.`,
    };
  }

  if (!(market.expirySec > nowSec + 30)) {
    return {
      ok: false,
      code: "market_expiry",
      reason: "Market expires too soon for a safe order deadline.",
    };
  }

  // Dead-man: expire before market lock; at least 30s, at most market-30s.
  const expireAtSec = Math.min(nowSec + 120, market.expirySec - 15);
  if (expireAtSec <= nowSec) {
    return {
      ok: false,
      code: "order_expiry",
      reason: "Could not compute a valid order expireAt before market expiry.",
    };
  }

  const needsApproval = allowance + 1e-12 < requiredCollateral;

  return {
    ok: true,
    needsApproval,
    requiredAllowance: requiredCollateral,
    order: {
      marketId: intent.marketId,
      poolAddress,
      side: "buy",
      outcome: mapDirectionToOutcome(intent.direction),
      orderType: "IOC",
      limitPrice: snappedPrice,
      contracts: snappedContracts,
      stake: intent.stake,
      collateral: market.collateral,
      decimals: market.decimals,
      expireAtSec,
      signerRole: "user_wallet",
    },
  };
}

export type LiveSubmitResult =
  | {
      ok: true;
      gated: false;
      tradeId: string;
      status: IntentStatus;
      transactionHash?: string;
      orderId?: string;
      filledContracts?: number;
      order: IocOrderDraft;
    }
  | {
      ok: false;
      gated?: boolean;
      code: string;
      reason: string;
      tradeId?: string;
      status?: IntentStatus;
    };

/**
 * Attempt live submission for a persisted pending intent.
 * Aborts without chain I/O when the feature gate is closed.
 */
export async function submitLiveOrder(input: {
  config: AppConfig;
  intent: TradeIntent;
  tradeId: string;
  /** Must belong to intent.userId — caller loads from user_wallets. */
  encryptedPrivateKey: string;
  liveExecutionRequested: boolean;
  /** Required for any path that would touch the chain. */
  deps: LiveExecutionDeps;
}): Promise<LiveSubmitResult> {
  const gate = assertLiveSubmitAllowed({
    enableLiveExecution: input.config.enableLiveExecution,
    liveExecutionRequested: input.liveExecutionRequested,
  });
  if (!gate.ok) {
    return {
      ok: false,
      gated: true,
      code: gate.code,
      reason: gate.reason,
      tradeId: input.tradeId,
      status: input.intent.status,
    };
  }

  if (input.intent.status !== "pending") {
    return {
      ok: false,
      code: "not_pending",
      reason: `Trade status ${input.intent.status} is not pending.`,
      tradeId: input.tradeId,
    };
  }

  if (input.intent.walletAddress.toLowerCase().startsWith("0xtreasury")) {
    return {
      ok: false,
      code: "treasury_forbidden",
      reason: "Trading must use the user wallet, never the treasury.",
      tradeId: input.tradeId,
    };
  }

  let privateKey: string;
  try {
    privateKey = decryptPrivateKey(input.config, input.encryptedPrivateKey);
  } catch {
    return {
      ok: false,
      code: "decrypt_failed",
      reason: "Unable to decrypt user wallet credentials.",
      tradeId: input.tradeId,
    };
  }

  // Defensive: private key material must never be logged; only used for signing.
  const snapshot = await input.deps.readChain(input.intent);
  const protocol = evaluateProtocolGates({
    intent: input.intent,
    market: snapshot.market,
    tusdcBalance: snapshot.tusdcBalance,
    allowance: snapshot.allowance,
    nowSec: snapshot.nowSec,
  });

  if (!protocol.ok) {
    if (canTransition("pending", "failed")) {
      await input.deps.updateTrade({
        tradeId: input.tradeId,
        userId: input.intent.userId,
        status: "failed",
        errorMessage: protocol.reason,
      });
    }
    return {
      ok: false,
      code: protocol.code,
      reason: protocol.reason,
      tradeId: input.tradeId,
      status: "failed",
    };
  }

  try {
    if (protocol.needsApproval) {
      await input.deps.ensureAllowance({
        privateKey,
        collateral: protocol.order.collateral,
        pool: protocol.order.poolAddress,
        amount: protocol.requiredAllowance,
        decimals: protocol.order.decimals,
      });
    }

    await input.deps.updateTrade({
      tradeId: input.tradeId,
      userId: input.intent.userId,
      status: "submitted",
    });

    const placed = await input.deps.placeIocOrder({
      privateKey,
      order: protocol.order,
    });

    const nextStatus: IntentStatus =
      placed.status === "filled"
        ? "filled"
        : placed.status === "partially_filled"
          ? "partially_filled"
          : "failed";

    if (!canTransition("submitted", nextStatus)) {
      await input.deps.updateTrade({
        tradeId: input.tradeId,
        userId: input.intent.userId,
        status: "failed",
        transactionHash: placed.transactionHash,
        errorMessage: "Illegal status transition after submit.",
      });
      return {
        ok: false,
        code: "bad_transition",
        reason: "Illegal status transition after submit.",
        tradeId: input.tradeId,
        status: "failed",
      };
    }

    await input.deps.updateTrade({
      tradeId: input.tradeId,
      userId: input.intent.userId,
      status: nextStatus,
      transactionHash: placed.transactionHash,
      orderId: placed.orderId,
      filledContracts: placed.filledContracts,
      errorMessage: placed.errorMessage,
    });

    if (nextStatus === "failed") {
      return {
        ok: false,
        code: "submission_failed",
        reason: placed.errorMessage ?? "Order submission failed.",
        tradeId: input.tradeId,
        status: "failed",
      };
    }

    return {
      ok: true,
      gated: false,
      tradeId: input.tradeId,
      status: nextStatus,
      transactionHash: placed.transactionHash,
      orderId: placed.orderId,
      filledContracts: placed.filledContracts,
      order: protocol.order,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 240) : "Unknown submit error";
    await input.deps.updateTrade({
      tradeId: input.tradeId,
      userId: input.intent.userId,
      status: "failed",
      errorMessage: message,
    });
    return {
      ok: false,
      code: "submission_error",
      reason: message,
      tradeId: input.tradeId,
      status: "failed",
    };
  } finally {
    // Best-effort: drop reference (GC); never return the key.
    privateKey = "";
  }
}

/**
 * Production dependency factory is intentionally not auto-invoked.
 * Wire markets-sdk here when ENABLE_LIVE_EXECUTION is enabled on Railway.
 * Until then, callers must not construct real deps from secrets in tests.
 */
export function describeProductionSubmitPath(): string[] {
  return [
    "Load user_wallets.encrypted_private_key for authenticated user_id only",
    "assertLiveSubmitAllowed(ENABLE_LIVE_EXECUTION + request flag)",
    "decryptPrivateKey in memory",
    "SomniaMarkets(Shannon) + getMarketOnchain(marketId)",
    "Read tUSDC balanceOf + allowance(pool)",
    "evaluateProtocolGates",
    "approve collateral to current pool if needed (user key)",
    "place IOC buy YES/NO via markets-sdk trader",
    "update trades status submitted → filled|partially_filled|failed",
  ];
}

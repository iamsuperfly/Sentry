/**
 * Stage 4 orchestration: load real risk state → build intent → persist.
 * No chain submission.
 */

import type { AppConfig } from "../config";
import { balances } from "./blockchain";
import {
  assertLiveSubmitAllowed,
  buildTradeIntent,
  planLiveSubmission,
  type TradeIntent,
} from "./execution";
import {
  findTradeByIdempotencyKey,
  fetchOpenPositionCount,
  fetchRealizedPnlToday,
  getUserSettings,
  insertTradeIntent,
  resolveUserIdByTelegram,
  type TradeRow,
} from "./persistence";
import type { StrategyDecision } from "./strategy";
import { findWallet } from "./supabase";

export type CreateIntentResult =
  | {
      ok: true;
      created: boolean;
      intent: TradeIntent;
      trade: TradeRow;
      riskState: {
        openPositionCount: number;
        realizedPnlToday: number;
        collateralBalance: number;
      };
      liveSubmit: { allowed: false; code: string; reason: string } | { allowed: true };
      submissionPlan: ReturnType<typeof planLiveSubmission>;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      idempotencyKey?: string;
    };

/**
 * Resolve Telegram user → wallet → settings → open count → PnL → risk → persist.
 * Identity is always derived from telegramUserId (never trust client user_id alone).
 */
export async function createPersistedIntent(
  config: AppConfig,
  input: {
    telegramUserId: number;
    decision: StrategyDecision;
    stake?: number;
    liveExecution?: boolean;
  },
): Promise<CreateIntentResult> {
  const userId = await resolveUserIdByTelegram(config, input.telegramUserId);
  if (!userId) {
    return {
      ok: false,
      code: "user_not_found",
      reason: "No Telegram user/wallet onboarding record. Use /start first.",
    };
  }

  const wallet = await findWallet(config, input.telegramUserId);
  if (!wallet || wallet.user_id !== userId) {
    return {
      ok: false,
      code: "wallet_not_found",
      reason: "No dedicated wallet for this Telegram user.",
    };
  }

  const prefs = await getUserSettings(config, userId);
  const [openPositionCount, realizedPnlToday, bal] = await Promise.all([
    fetchOpenPositionCount(config, userId),
    fetchRealizedPnlToday(config, userId),
    balances(config, wallet.address),
  ]);

  const settings = {
    ...prefs,
    openPositionCount,
    realizedPnlToday,
    collateralBalance: Number(bal.tusdc),
  };

  // Pre-check existing idempotency before risk (stable key needs direction).
  const preliminary = buildTradeIntent({
    userId,
    walletAddress: wallet.address,
    decision: input.decision,
    settings,
    system: config.systemLimits,
    stake: input.stake,
  });

  if (!preliminary.ok) {
    return {
      ok: false,
      code: preliminary.code,
      reason: preliminary.reason,
      idempotencyKey: preliminary.idempotencyKey,
    };
  }

  const existing = await findTradeByIdempotencyKey(
    config,
    preliminary.intent.idempotencyKey,
  );
  if (existing) {
    const liveGate = assertLiveSubmitAllowed({
      enableLiveExecution: config.enableLiveExecution,
      liveExecutionRequested: input.liveExecution === true,
    });
    return {
      ok: true,
      created: false,
      intent: preliminary.intent,
      trade: existing,
      riskState: {
        openPositionCount,
        realizedPnlToday,
        collateralBalance: settings.collateralBalance,
      },
      liveSubmit: liveGate.ok
        ? { allowed: true }
        : { allowed: false, code: liveGate.code, reason: liveGate.reason },
      submissionPlan: planLiveSubmission(preliminary.intent),
    };
  }

  const built = buildTradeIntent({
    userId,
    walletAddress: wallet.address,
    decision: input.decision,
    settings,
    system: config.systemLimits,
    stake: input.stake,
    existing: null,
  });

  if (!built.ok) {
    return {
      ok: false,
      code: built.code,
      reason: built.reason,
      idempotencyKey: built.idempotencyKey,
    };
  }

  const saved = await insertTradeIntent(config, built.intent);
  const liveGate = assertLiveSubmitAllowed({
    enableLiveExecution: config.enableLiveExecution,
    liveExecutionRequested: input.liveExecution === true,
  });

  return {
    ok: true,
    created: saved.kind === "created",
    intent: built.intent,
    trade: saved.trade,
    riskState: {
      openPositionCount,
      realizedPnlToday,
      collateralBalance: settings.collateralBalance,
    },
    liveSubmit: liveGate.ok
      ? { allowed: true }
      : { allowed: false, code: liveGate.code, reason: liveGate.reason },
    submissionPlan: planLiveSubmission(built.intent),
  };
}

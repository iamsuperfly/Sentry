import type { AppConfig } from "../config.ts";
import { findWallet, ensureUser } from "./supabase.ts";
import { getTradeIntentForUser } from "./trade-persistence.ts";
import {
  createProductionLiveExecutionDeps,
} from "./live-execution-adapter.ts";
import { submitLiveOrder, type LiveSubmitResult } from "./live-execution.ts";
import type { TelegramIdentity } from "./trade-persistence.ts";

/**
 * Authenticated execution boundary. The caller supplies only Telegram identity
 * and a persisted trade id; wallet, user id, market parameters and risk inputs
 * are all loaded server-side.
 */
export async function executePersistedTradeForTelegram(input: {
  config: AppConfig;
  identity: TelegramIdentity;
  tradeId: string;
  liveExecutionRequested: boolean;
}): Promise<LiveSubmitResult> {
  const userId = await ensureUser(input.config, input.identity);
  const wallet = await findWallet(input.config, input.identity.id);
  if (!wallet || wallet.user_id !== userId) {
    return {
      ok: false,
      code: "wallet_not_owned",
      reason: "The Telegram user does not own an execution wallet.",
      tradeId: input.tradeId,
    };
  }

  const intent = await getTradeIntentForUser(
    input.config,
    userId,
    input.tradeId,
  );
  if (!intent) {
    return {
      ok: false,
      code: "trade_not_found",
      reason: "Trade intent was not found for this Telegram user.",
      tradeId: input.tradeId,
    };
  }
  if (intent.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) {
    return {
      ok: false,
      code: "wallet_mismatch",
      reason: "Trade intent wallet does not match the authenticated user wallet.",
      tradeId: input.tradeId,
    };
  }

  return submitLiveOrder({
    config: input.config,
    intent,
    tradeId: input.tradeId,
    encryptedPrivateKey: wallet.encrypted_private_key,
    liveExecutionRequested: input.liveExecutionRequested,
    deps: createProductionLiveExecutionDeps(input.config),
  });
}
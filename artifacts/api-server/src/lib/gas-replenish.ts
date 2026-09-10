/**
 * Automatic STT gas replenishment from the Sentry treasury.
 * Reuses sponsor(). No treasury spending cap. One replenish per submit.
 */

import type { AppConfig } from "../config.ts";
import { receipt, sponsor } from "./blockchain.ts";
import { logger } from "./logger.ts";
import { createTransaction, updateTransaction } from "./supabase.ts";

export const STT_GAS_REPLENISH_TYPE = "STT_GAS_REPLENISH";

export type GasReplenishResult =
  | { ok: true; hash: string; amount: string; sponsored: true }
  | { ok: false; code: string; reason: string };

export async function replenishUserSttGas(input: {
  config: AppConfig;
  userId: string;
  walletAddress: string;
}): Promise<GasReplenishResult> {
  const amount = input.config.initialGasSponsorAmount;
  let txId: string | null = null;
  try {
    txId = await createTransaction(input.config, {
      userId: input.userId,
      walletAddress: input.walletAddress,
      type: STT_GAS_REPLENISH_TYPE,
      amount,
      tokenSymbol: "STT",
      fromAddress: undefined,
      toAddress: input.walletAddress,
    });
    const funded = await sponsor(input.config, input.walletAddress);
    await updateTransaction(input.config, txId, {
      transaction_hash: funded.hash,
      from_address: funded.from,
      status: "submitted",
    });
    const confirmed = await receipt(input.config, funded.hash);
    await updateTransaction(input.config, txId, {
      status: confirmed.status,
      confirmed_block: confirmed.blockNumber,
    });
    if (confirmed.status !== "confirmed") {
      return {
        ok: false,
        code: "gas_replenish_failed",
        reason: "Sentry STT sponsorship transaction did not confirm.",
      };
    }
    logger.info(
      { userId: input.userId, hash: funded.hash, amount },
      "STT gas replenished by Sentry treasury",
    );
    return { ok: true, hash: funded.hash, amount, sponsored: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 200) : "STT replenish failed.";
    if (txId) {
      try {
        await updateTransaction(input.config, txId, {
          status: "failed",
          error_message: message,
        });
      } catch {
        /* ignore persistence of replenish failure */
      }
    }
    return { ok: false, code: "gas_replenish_failed", reason: message };
  }
}

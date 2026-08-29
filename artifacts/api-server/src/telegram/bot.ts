import { Bot, InlineKeyboard, type Context } from "grammy";
import type { AppConfig } from "../config";
import { logger } from "../lib/logger";
import {
  balances,
  createWallet,
  explorer,
  faucet,
  inspectReceipt,
  receipt,
  sponsor,
} from "../lib/blockchain";
import { parseFaucetAmount } from "../lib/faucet";
import {
  createTransaction,
  ensureUser,
  findWallet,
  getOnboardingTransactions,
  getFaucetAllowance,
  reserveFaucetTransaction,
  saveWallet,
  updateTransaction,
} from "../lib/supabase";
import { decryptPrivateKey, encryptPrivateKey } from "../lib/wallet-crypto";
import { runTelegramTradeCycle } from "../lib/trade-orchestration";

function formatTradeScanLine(scan: {
  discovered: number;
  tradable: number;
  withUsableAsks?: number;
  btc?: number;
  eth?: number;
  byDuration?: Record<string, number>;
  availableSlots?: number;
  selected?: number;
}): string {
  const parts = [
    `Markets found: ${scan.discovered}`,
    `tradable: ${scan.tradable}`,
  ];
  if (scan.withUsableAsks !== undefined) {
    parts.push(`usable asks: ${scan.withUsableAsks}`);
  }
  if (scan.btc !== undefined && scan.eth !== undefined) {
    parts.push(`BTC: ${scan.btc}`, `ETH: ${scan.eth}`);
  }
  if (scan.byDuration) {
    const d = scan.byDuration;
    parts.push(
      `1m=${d["1m"] ?? 0} 5m=${d["5m"] ?? 0} 15m=${d["15m"] ?? 0} 1h=${d["1h"] ?? 0} 4h=${d["4h"] ?? 0} 1d=${d["1d"] ?? 0}`,
    );
  }
  if (scan.availableSlots !== undefined) {
    parts.push(`available slots: ${scan.availableSlots}`);
  }
  if (scan.selected !== undefined) parts.push(`selected: ${scan.selected}`);
  return parts.join(" · ");
}

import {
  applySettingsPatch,
  formatSettingsHelp,
  formatUserSettings,
  parseSettingsCommand,
  shouldRequestLiveExecution,
} from "../lib/telegram-settings";
import {
  disableTradingForTelegram,
  getRealizedPnlToday,
  getUserSettingsForTelegram,
  saveUserSettingsForTelegram,
} from "../lib/trade-persistence";
import { getActiveOpenPositionCount } from "../lib/active-positions";
import {
  formatHistoryMessage,
  formatPositionsMessage,
  listActivePositionsForDisplay,
  listHistoryForDisplay,
} from "../lib/position-display";
import {
  formatExecutionModeLabel,
  formatTradeExecutionMessage,
  formatUserFacingTradeFailure,
} from "../lib/telegram-trade-format";
import { formatMultiTradeReply } from "../lib/telegram-multi-trade-reply";
import { startFinalizationLoop } from "./finalization-loop";
import { registerClaimCommand } from "./register-claim-command";

const active = new Set<number>();
const lastStart = new Map<number, number>();
const cooldownMs = 30_000;
const tradeActive = new Set<number>();

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return /key|secret|token|credential|supabase/i.test(message)
    ? "A secure service configuration error occurred."
    : message.slice(0, 180);
}

function link(config: AppConfig, hash: string) {
  return new InlineKeyboard().url("View transaction", explorer(config, hash));
}

async function confirm(
  ctx: Context,
  config: AppConfig,
  transactionId: string,
  hash: `0x${string}`,
  message: string | (() => Promise<string>),
) {
  try {
    const result = await receipt(config, hash);
    await updateTransaction(config, transactionId, {
      transaction_hash: hash,
      status: result.status,
      block_number: result.blockNumber,
      confirmed_at:
        result.status === "confirmed" ? new Date().toISOString() : null,
      error_message:
        result.status === "failed" ? "Transaction reverted on-chain." : null,
    });
    if (result.status === "failed") {
      await ctx.reply(
        `❌ Transaction failed.\n\nReason: Transaction reverted on-chain.\nTransaction: ${hash}`,
        { reply_markup: link(config, hash) },
      );
      return false;
    }
    const text = typeof message === "function" ? await message() : message;
    await ctx.reply(`${text}\n\nTransaction confirmed.\n\nTransaction: ${hash}`, {
      reply_markup: link(config, hash),
    });
    return true;
  } catch (error) {
    await updateTransaction(config, transactionId, {
      transaction_hash: hash,
      status: "submitted",
      error_message:
        "Confirmation is still pending or the RPC became unavailable.",
    }).catch(() => undefined);
    await ctx.reply(
      `❌ Transaction failed.\n\nReason: ${safeError(error)}\nTransaction: ${hash}`,
      { reply_markup: link(config, hash) },
    );
    return false;
  }
}

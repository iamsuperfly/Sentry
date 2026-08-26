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
import { startFinalizationLoop } from "./finalization-loop";

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

// NOTE: Full bot body continues below — this is a partial restore marker.
export function createTelegramBot(config: AppConfig): Bot {
  throw new Error("INCOMPLETE_BOT_PUSH — restore from pure_1 required");
}

export function startTelegramBot(config: AppConfig): Bot {
  throw new Error("INCOMPLETE_BOT_PUSH — restore from pure_1 required");
}

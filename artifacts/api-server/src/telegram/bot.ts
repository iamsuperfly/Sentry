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
import { formatUserPerformance } from "../lib/performance-persist";

import { type Bot, type Context } from "grammy";
import type { AppConfig } from "../config";
import { balances, faucet, inspectReceipt } from "../lib/blockchain";
import { parseFaucetAmount } from "../lib/faucet";
import { logger } from "../lib/logger";
import {
  BTN,
  DEFAULT_FAUCET_AMOUNT,
  formatAskStep,
  formatDashboard,
  formatOnboardConfirm,
  formatOnboardIntro,
  formatSettingsSnapshot,
  isMainMenuLabel,
  rangeHint,
  seedDraft,
  SETUP_COMPLETE_TEXT,
  tryApplyOnboardValue,
  tryApplySetting,
  type SettingField,
} from "../lib/telegram-app-flow";
import {
  ensureUser,
  findWallet,
  getOnboardingTransactions,
  reserveFaucetTransaction,
  updateTransaction,
} from "../lib/supabase";
import {
  getUserSettingsForTelegram,
  saveUserSettingsForTelegram,
} from "../lib/trade-persistence";
import { getActiveOpenPositionCount } from "../lib/active-positions";
import { getPerformanceSummary } from "../lib/performance-persist";
import { formatPerformanceMessage } from "../lib/performance-summary";
import {
  formatPositionsMessage,
  listActivePositionsForDisplay,
} from "../lib/position-display";
import { formatUserFacingTradeFailure } from "../lib/telegram-trade-format";
import { formatMultiTradeReply } from "../lib/telegram-multi-trade-reply";
import { shouldRequestLiveExecution } from "../lib/telegram-settings";
import { runTelegramTradeCycle } from "../lib/trade-orchestration";
import { setAutonomousEnabled } from "../lib/autonomous-state";
import { formatClaimMessage, runUserClaimScan } from "../lib/claim-positions";
import { resumeAutonomousIfEnabled } from "./register-phase-commands";
import {
  hidePrivateKey,
  revealPrivateKey,
  showHistory,
  showLeaderboard,
  warnPrivateKey,
} from "./register-help-extras";
import { clearConversation, getConversation, setConversation } from "./conversation";
import {
  autoKeyboard,
  backToMenuKeyboard,
  faucetKeyboard,
  helpKeyboard,
  mainReplyKeyboard,
  positionsKeyboard,
  settingsKeyboard,
} from "./ui-keyboards";

const tradeActive = new Set<number>();

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return /key|secret|token|credential|supabase/i.test(message)
    ? "Something went wrong. Please try again."
    : message.slice(0, 180);
}

function identityFrom(ctx: Context) {
  const from = ctx.from!;
  return {
    id: from.id,
    username: from.username,
    first_name: from.first_name,
    last_name: from.last_name,
  };
}

async function enableTrading(config: AppConfig, ctx: Context) {
  const current = await getUserSettingsForTelegram(config, identityFrom(ctx));
  if (current.tradingEnabled) return current;
  return saveUserSettingsForTelegram(config, identityFrom(ctx), {
    ...current,
    tradingEnabled: true,
    executionMode: "testnet",
  });
}

function formatTradeScanLine(scan: {
  discovered: number;
  tradable: number;
  withUsableAsks?: number;
  btc?: number;
  eth?: number;
  availableSlots?: number;
  selected?: number;
}): string {
  const parts = [`Markets found: ${scan.discovered}`, `tradable: ${scan.tradable}`];
  if (scan.withUsableAsks !== undefined) parts.push(`usable asks: ${scan.withUsableAsks}`);
  if (scan.btc !== undefined && scan.eth !== undefined) {
    parts.push(`BTC: ${scan.btc}`, `ETH: ${scan.eth}`);
  }
  if (scan.availableSlots !== undefined) parts.push(`available slots: ${scan.availableSlots}`);
  if (scan.selected !== undefined) parts.push(`selected: ${scan.selected}`);
  return parts.join(" · ");
}

async function reconcileFaucetTransactions(
  config: AppConfig,
  userId: string,
  walletAddress: string,
) {
  const transactions = await getOnboardingTransactions(config, userId, walletAddress);
  for (const transaction of transactions.filter((i) => i.type === "TUSDC_FAUCET")) {
    if (transaction.status === "confirmed" || !transaction.transaction_hash) {
      if (transaction.status === "pending" && !transaction.transaction_hash) {
        await updateTransaction(config, transaction.id, {
          status: "failed",
          error_message: "No blockchain hash was recorded; faucet allowance released.",
        });
      }
      continue;
    }
    const inspected = await inspectReceipt(config, transaction.transaction_hash);
    if (inspected) {
      await updateTransaction(config, transaction.id, {
        status: inspected.status,
        block_number: inspected.blockNumber,
        confirmed_at: inspected.status === "confirmed" ? new Date().toISOString() : null,
        error_message:
          inspected.status === "failed"
            ? "Transaction reverted on-chain; faucet allowance released."
            : null,
      });
    }
  }
}

async function runFaucetAmount(
  ctx: Context,
  config: AppConfig,
  amountRaw: string,
): Promise<boolean> {
  let amount: string;
  try {
    amount = parseFaucetAmount(amountRaw);
  } catch {
    await ctx.reply("That amount is not valid. Use a number up to 500 tUSDC.", {
      reply_markup: faucetKeyboard(true),
    });
    return false;
  }
  try {
    const wallet = await findWallet(config, ctx.from!.id);
    if (!wallet) {
      await ctx.reply("Tap Start first to create your wallet.");
      return false;
    }
    const userId = await ensureUser(config, ctx.from!);
    await reconcileFaucetTransactions(config, userId, wallet.address);
    const reservation = await reserveFaucetTransaction(config, {
      userId,
      walletAddress: wallet.address,
      amount,
    });
    try {
      const faucetTx = await faucet(config, wallet.encrypted_private_key, amount);
      await updateTransaction(config, reservation.transaction_id, {
        transaction_hash: faucetTx.hash,
        status: "submitted",
      });
      await ctx.reply(`Requesting ${amount} tUSDC…`);
      const current = await balances(config, wallet.address);
      await ctx.reply(`Received ${amount} tUSDC.\n\nBalance: ${current.tusdc} tUSDC`);
      return true;
    } catch (error) {
      await updateTransaction(config, reservation.transaction_id, {
        status: "failed",
        error_message: safeError(error),
      }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    logger.error({ err: safeError(error) }, "app faucet failed");
    await ctx.reply("Could not send test tokens right now. Try again in a moment.", {
      reply_markup: faucetKeyboard(true),
    });
    return false;
  }
}

async function beginConfiguration(ctx: Context, config: AppConfig) {
  const settings = await getUserSettingsForTelegram(config, identityFrom(ctx));
  setConversation(ctx.from!.id, {
    kind: "onboard",
    step: "stake",
    draft: seedDraft(settings),
  });
  await ctx.reply(formatOnboardIntro(settings, config.systemLimits));
}

export async function startAppOnboarding(ctx: Context, config: AppConfig) {
  if (!ctx.from) return;
  const wallet = await findWallet(config, ctx.from.id);
  let returning = false;
  if (wallet) {
    try {
      const current = await balances(config, wallet.address);
      returning = Number(current.tusdc) > 0;
    } catch {
      returning = false;
    }
  }
  setConversation(ctx.from.id, { kind: "onboard_faucet", returning });
  await ctx.reply(
    [
      "DreamEventBot trades BTC and ETH event contracts on Somnia testnet.",
      "",
      "Setup takes less than 2 minutes.",
      "",
      returning
        ? "Get test tokens, or skip if you already have a balance."
        : "First, get test tokens so you can trade.",
    ].join("\n"),
    { reply_markup: faucetKeyboard(returning) },
  );
}

export async function showDashboard(ctx: Context, config: AppConfig) {
  if (!ctx.from) return;
  clearConversation(ctx.from.id);
  const wallet = await findWallet(config, ctx.from.id);
  if (!wallet) {
    await ctx.reply("Tap Start to create your wallet first.");
    return;
  }
  const settings = await getUserSettingsForTelegram(config, identityFrom(ctx));
  const [current, openCount, performance] = await Promise.all([
    balances(config, wallet.address),
    getActiveOpenPositionCount(config, settings.userId),
    getPerformanceSummary(config, settings.userId, new Date(), settings.timezone),
  ]);
  await ctx.reply(
    formatDashboard({
      tusdc: current.tusdc,
      openPositions: openCount,
      maxOpenPositions: settings.maxOpenPositions,
      dailyPnl: performance.dailyPnl,
      autonomousEnabled: settings.autonomousEnabled,
      autonomousPaused: Boolean(settings.autonomousPausedAt),
    }),
    { reply_markup: mainReplyKeyboard(settings.autonomousEnabled) },
  );
}

export async function runTradeNow(ctx: Context, config: AppConfig) {
  if (!ctx.from) return;
  if (tradeActive.has(ctx.from.id)) {
    await ctx.reply("A trade cycle is already in progress.");
    return;
  }
  tradeActive.add(ctx.from.id);
  try {
    const wallet = await findWallet(config, ctx.from.id);
    if (!wallet) {
      await ctx.reply("Tap Start to create your wallet first.");
      return;
    }
    const settings = await enableTrading(config, ctx);
    if (settings.autonomousEnabled) {
      await resumeAutonomousIfEnabled(config, settings.userId, ctx.chat.id);
    }
    const liveRequested = shouldRequestLiveExecution(settings.executionMode, true);
    const result = await runTelegramTradeCycle({
      config,
      identity: identityFrom(ctx),
      liveExecutionRequested: liveRequested,
      stake: settings.defaultStake,
    });
    if (!result.ok) {
      const scan = result.marketScan ? `\n\n${formatTradeScanLine(result.marketScan)}` : "";
      await ctx.reply(
        formatUserFacingTradeFailure({ code: result.code, reason: result.reason }) + scan,
        { reply_markup: mainReplyKeyboard(settings.autonomousEnabled) },
      );
      return;
    }
    await ctx.reply(
      formatMultiTradeReply({
        trades: result.trades ?? [],
        fallback: {
          tradeId: result.tradeId,
          intentSymbol: result.intentSymbol,
          decision: result.decision,
          stake: result.stake,
          execution: result.execution,
        },
        marketsLine: formatTradeScanLine(result.marketScan),
        executionMode: settings.executionMode,
        explorerTxBaseUrl: config.explorerTxBaseUrl,
      }),
      {
        link_preview_options: { is_disabled: true },
        reply_markup: mainReplyKeyboard(settings.autonomousEnabled),
      },
    );
  } catch (error) {
    logger.error({ err: safeError(error) }, "app TRADE NOW failed");
    await ctx.reply("Trade could not be completed. Please try again shortly.", {
      reply_markup: backToMenuKeyboard(),
    });
  } finally {
    tradeActive.delete(ctx.from.id);
  }
}

async function showAuto(ctx: Context, config: AppConfig) {
  const settings = await getUserSettingsForTelegram(config, identityFrom(ctx));
  const on = settings.autonomousEnabled;
  await ctx.reply(
    on
      ? "Autonomous trading is running.\n\nThe bot scans every 6 minutes and manages eligible positions automatically."
      : "Autonomous trading is paused.",
    { reply_markup: autoKeyboard(on) },
  );
}

async function setAuto(ctx: Context, config: AppConfig, enabled: boolean) {
  const settings = await enableTrading(config, ctx);
  await setAutonomousEnabled(config, settings.userId, enabled, ctx.chat?.id ?? ctx.from!.id);
  await ctx.reply(
    enabled
      ? "Autonomous trading is running.\n\nThe bot scans every 6 minutes and manages eligible positions automatically."
      : "Autonomous trading is paused.",
    { reply_markup: mainReplyKeyboard(enabled) },
  );
}

async function showPositions(ctx: Context, config: AppConfig) {
  const userId = await ensureUser(config, ctx.from!);
  const positions = await listActivePositionsForDisplay(config, userId);
  const text =
    positions.length === 0
      ? "No open positions."
      : formatPositionsMessage(positions, config.explorerTxBaseUrl);
  await ctx.reply(text, {
    link_preview_options: { is_disabled: true },
    reply_markup: positionsKeyboard(),
  });
}

async function showPerformance(ctx: Context, config: AppConfig) {
  const settings = await getUserSettingsForTelegram(config, identityFrom(ctx));
  const performance = await getPerformanceSummary(
    config,
    settings.userId,
    new Date(),
    settings.timezone,
  );
  const decided = performance.wins + performance.losses;
  const winRate = decided > 0 ? `${Math.round((performance.wins / decided) * 100)}%` : "\u2014";
  await ctx.reply(
    [formatPerformanceMessage(performance), "", `Win rate: ${winRate}`, `Total decided trades: ${decided}`].join(
      "\n",
    ),
    { reply_markup: backToMenuKeyboard() },
  );
}

async function showWallet(ctx: Context, config: AppConfig) {
  const wallet = await findWallet(config, ctx.from!.id);
  if (!wallet) {
    await ctx.reply("Tap Start to create your wallet first.");
    return;
  }
  const current = await balances(config, wallet.address);
  const short = `${wallet.address.slice(0, 6)}\u2026${wallet.address.slice(-4)}`;
  await ctx.reply(
    [
      "Wallet",
      "",
      `Address: ${short}`,
      `tUSDC: ${current.tusdc}`,
      `STT: ${current.stt}`,
      "Network: Somnia Shannon testnet",
    ].join("\n"),
    { reply_markup: backToMenuKeyboard() },
  );
}

async function runClaim(ctx: Context, config: AppConfig) {
  const wallet = await findWallet(config, ctx.from!.id);
  if (!wallet) {
    await ctx.reply("Tap Start to create your wallet first.");
    return;
  }
  const userId = await ensureUser(config, ctx.from!);
  await ctx.reply("Checking settled positions\u2026");
  const attempts = await runUserClaimScan({
    config,
    userId,
    walletAddress: wallet.address,
    encryptedPrivateKey: wallet.encrypted_private_key,
  });
  await ctx.reply(formatClaimMessage(attempts), {
    link_preview_options: { is_disabled: true },
    reply_markup: backToMenuKeyboard(),
  });
}

async function showHelp(ctx: Context) {
  await ctx.reply("Help", { reply_markup: helpKeyboard() });
}

async function showSettings(ctx: Context, config: AppConfig) {
  const settings = await getUserSettingsForTelegram(config, identityFrom(ctx));
  await ctx.reply(formatSettingsSnapshot(settings), { reply_markup: settingsKeyboard() });
}

async function askSetting(ctx: Context, field: SettingField, config: AppConfig) {
  setConversation(ctx.from!.id, { kind: "setting", field });
  await ctx.reply(`Enter your new value:\n\n${rangeHint(field, config.systemLimits)}`);
}

export async function handleConversationText(
  ctx: Context,
  config: AppConfig,
): Promise<boolean> {
  if (!ctx.from || !ctx.message || typeof ctx.message.text !== "string") return false;
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return false;
  if (isMainMenuLabel(text) || text.startsWith(BTN.autonomous)) {
    clearConversation(ctx.from.id);
    if (text === BTN.tradeNow) await runTradeNow(ctx, config);
    else if (text.startsWith(BTN.autonomous)) await showAuto(ctx, config);
    else if (text === BTN.positions) await showPositions(ctx, config);
    else if (text === BTN.performance) await showPerformance(ctx, config);
    else if (text === BTN.wallet) await showWallet(ctx, config);
    else if (text === BTN.help) await showHelp(ctx);
    return true;
  }

  const state = getConversation(ctx.from.id);
  if (state.kind === "idle" || state.kind === "onboard_faucet") return false;

  if (state.kind === "faucet_amount") {
    const ok = await runFaucetAmount(ctx, config, text);
    if (ok) {
      clearConversation(ctx.from.id);
      await beginConfiguration(ctx, config);
    }
    return true;
  }

  if (state.kind === "onboard") {
    const applied = tryApplyOnboardValue(state.draft, state.step, text, config.systemLimits);
    if (!applied.ok) {
      await ctx.reply(`${applied.reason}\n\n${rangeHint(state.step, config.systemLimits)}`);
      return true;
    }
    const confirm = formatOnboardConfirm(state.step, applied.settings);
    if (applied.next) {
      setConversation(ctx.from.id, {
        kind: "onboard",
        step: applied.next,
        draft: applied.settings,
      });
      await ctx.reply(`${confirm}\n\n${formatAskStep(applied.next)}`);
      return true;
    }
    await saveUserSettingsForTelegram(config, identityFrom(ctx), {
      ...applied.settings,
      tradingEnabled: true,
    });
    clearConversation(ctx.from.id);
    await ctx.reply(SETUP_COMPLETE_TEXT);
    await showDashboard(ctx, config);
    return true;
  }

  if (state.kind === "setting") {
    const current = await getUserSettingsForTelegram(config, identityFrom(ctx));
    const applied = tryApplySetting(current, state.field, text, config.systemLimits);
    if (!applied.ok) {
      await ctx.reply(`${applied.reason}\n\n${rangeHint(state.field, config.systemLimits)}`);
      return true;
    }
    await saveUserSettingsForTelegram(config, identityFrom(ctx), applied.settings);
    clearConversation(ctx.from.id);
    await ctx.reply(applied.label);
    await showSettings(ctx, config);
    return true;
  }

  return false;
}

export function registerAppUi(bot: Bot, config: AppConfig): void {
  bot.callbackQuery("app:faucet", async (ctx) => {
    await ctx.answerCallbackQuery();
    const ok = await runFaucetAmount(ctx, config, DEFAULT_FAUCET_AMOUNT);
    if (ok) await beginConfiguration(ctx, config);
  });
  bot.callbackQuery("app:faucet_skip", async (ctx) => {
    await ctx.answerCallbackQuery();
    await beginConfiguration(ctx, config);
  });
  bot.callbackQuery("app:menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDashboard(ctx, config);
  });
  bot.callbackQuery("app:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHelp(ctx);
  });
  bot.callbackQuery("app:help_trading", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "Trading",
        "",
        "TRADE NOW runs one market scan and places trades when conditions match.",
        "AUTONOMOUS repeats that scan every 6 minutes.",
      ].join("\n"),
      { reply_markup: helpKeyboard() },
    );
  });
  bot.callbackQuery("app:how", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "How it works",
        "",
        "1. Get test tokens.",
        "2. Set your stake and limits.",
        "3. Tap TRADE NOW or start autonomous trading.",
        "4. Claim settled wins from Positions or Help.",
      ].join("\n"),
      { reply_markup: helpKeyboard() },
    );
  });
  bot.callbackQuery("app:settings", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSettings(ctx, config);
  });
  bot.callbackQuery("app:wallet", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showWallet(ctx, config);
  });
  bot.callbackQuery("app:auto", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showAuto(ctx, config);
  });
  bot.callbackQuery("app:auto_on", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAuto(ctx, config, true);
  });
  bot.callbackQuery("app:auto_off", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAuto(ctx, config, false);
  });
  bot.callbackQuery("app:claim", async (ctx) => {
    await ctx.answerCallbackQuery();
    await runClaim(ctx, config);
  });
  bot.callbackQuery("app:set_stake", async (ctx) => {
    await ctx.answerCallbackQuery();
    await askSetting(ctx, "defaultStake", config);
  });
  bot.callbackQuery("app:set_max", async (ctx) => {
    await ctx.answerCallbackQuery();
    await askSetting(ctx, "maxTradeStake", config);
  });
  bot.callbackQuery("app:set_loss", async (ctx) => {
    await ctx.answerCallbackQuery();
    await askSetting(ctx, "maxDailyLoss", config);
  });
  bot.callbackQuery("app:set_pos", async (ctx) => {
    await ctx.answerCallbackQuery();
    await askSetting(ctx, "maxOpenPositions", config);
  });
  bot.callbackQuery("app:set_profit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await askSetting(ctx, "dailyProfitTarget", config);
  });
  bot.callbackQuery("app:history", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHistory(ctx, config);
  });
  bot.callbackQuery("app:leaderboard", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showLeaderboard(ctx, config);
  });
  bot.callbackQuery("app:pk_warn", async (ctx) => {
    await ctx.answerCallbackQuery();
    await warnPrivateKey(ctx);
  });
  bot.callbackQuery("app:pk_reveal", async (ctx) => {
    await ctx.answerCallbackQuery();
    await revealPrivateKey(ctx, config);
  });
  bot.callbackQuery("app:pk_hide", async (ctx) => {
    await ctx.answerCallbackQuery();
    await hidePrivateKey(ctx);
  });
}

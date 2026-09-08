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
      "Sentry trades BTC and ETH event contracts on Somnia testnet.",
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
      await ctx.reply(
        formatUserFacingTradeFailure({ code: result.code, reason: result.reason }),
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
        marketsLine: "",
        executionMode: settings.executionMode,
        explorerTxBaseUrl: config.explorerTxBaseUrl,
      }),
      {
        link_preview_options: { is_disabled: true },
      },
    );
  } catch (error) {
    logger.error({ err: safeError(error) }, "app TRADE NOW failed");
    await ctx.reply(
      [
        "\u26aa Trade could not be completed",
        "",
        "Something went wrong on our side. Please try again shortly.",
        "No funds were used unless you already see a confirmed transaction.",
      ].join("\n"),
    );
  } finally {
    tradeActive.delete(ctx.from.id);
  }
}

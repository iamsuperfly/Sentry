import type { Bot } from "grammy";
import type { AppConfig } from "../config.ts";
import { formatClaimMessage, runUserClaimScan } from "./claim-positions.ts";
import {
  formatEarlyExitMessage,
  manageOpenPositions,
} from "./early-exit-manage.ts";
import { logger } from "./logger.ts";
import { findWallet } from "./supabase.ts";
import { formatMultiTradeReply } from "./telegram-multi-trade-reply.ts";
import { formatUserFacingTradeFailure } from "./telegram-trade-format.ts";
import { shouldRequestLiveExecution } from "./telegram-settings.ts";
import { runSafeTelegramTradeCycle } from "./trade-cycle-safe.ts";
import {
  listAutonomousCandidates,
  markAutonomousScan,
  pauseAutonomousForLocalDay,
  shouldRunAutonomousTick,
} from "./autonomous-state.ts";
import { buildAutonomousTradeCycleInput } from "./autonomous-input.ts";
import { calendarDateInZone } from "./user-timezone.ts";
import {
  getPerformanceSummary,
  listUtcDayTradeStatuses,
} from "./performance-persist.ts";
import {
  getRealizedPnlToday,
  getUserSettings,
} from "./trade-persistence.ts";
import {
  evaluateDayHalt,
  formatAutonomousDailyReport,
  formatDayHaltMessage,
  summarizeDayActivity,
  type DayHaltCode,
} from "./risk-supervisor.ts";

const INTERVAL_MS = 6 * 60 * 1000;

function errText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return fallback;
}

async function sendTelegram(
  bot: Bot,
  chatId: number,
  text: string,
): Promise<void> {
  await bot.api.sendMessage(chatId, text, {
    link_preview_options: { is_disabled: true },
  });
}

async function notifyChat(
  bot: Bot,
  chatId: number | null,
  telegramUserId: number,
  text: string,
  userId?: string,
): Promise<void> {
  const primary = chatId && Number.isFinite(chatId) ? chatId : telegramUserId;
  const fallback =
    telegramUserId && telegramUserId !== primary ? telegramUserId : null;
  if (!primary) {
    logger.warn({ userId, chatId, telegramUserId }, "autonomous telegram notify skipped (no chat id)");
    return;
  }
  try {
    await sendTelegram(bot, primary, text);
    logger.info(
      { userId, destinationChatId: primary, chars: text.length },
      "autonomous telegram notify sent",
    );
    return;
  } catch (error) {
    logger.warn(
      {
        userId,
        chatId: primary,
        err: errText(error, "notify"),
        stack: error instanceof Error ? error.stack?.slice(0, 400) : undefined,
      },
      "autonomous telegram notify failed",
    );
  }
  if (fallback) {
    try {
      await sendTelegram(bot, fallback, text);
      logger.info(
        {
          userId,
          destinationChatId: fallback,
          via: "telegramUserId",
        },
        "autonomous telegram notify sent",
      );
    } catch (error) {
      logger.warn(
        {
          userId,
          chatId: fallback,
          err: errText(error, "notify-fallback"),
        },
        "autonomous telegram notify fallback failed",
      );
    }
  }
}

async function buildDailyReport(
  config: AppConfig,
  userId: string,
  now: Date,
): Promise<string> {
  const [performance, statuses] = await Promise.all([
    getPerformanceSummary(config, userId, now, "UTC"),
    listUtcDayTradeStatuses(config, userId, now),
  ]);
  return formatAutonomousDailyReport({
    activity: summarizeDayActivity(statuses),
    dailyPnl: performance.dailyPnl,
    wins: performance.wins,
    losses: performance.losses,
    unclaimedPositions: performance.unclaimedPositions,
    unclaimedValue: performance.unclaimedValue,
  });
}

export async function runAutonomousTick(
  bot: Bot,
  config: AppConfig,
  now = new Date(),
): Promise<void> {
  let rows;
  try {
    rows = await listAutonomousCandidates(config);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : "list failed" },
      "autonomous candidate list failed",
    );
    return;
  }

  for (const row of rows) {
    const decision = shouldRunAutonomousTick(row, now);
    if (decision.pauseForNewDay) {
      const localDate = calendarDateInZone(now, row.timezone);
      try {
        let report =
          "Autonomous trading stopped for the UTC day.\n\nSend /trade or /auto on to start again tomorrow.";
        try {
          report = await buildDailyReport(config, row.userId, now);
        } catch (error) {
          logger.warn(
            {
              userId: row.userId,
              err: error instanceof Error ? error.message.slice(0, 120) : "report",
            },
            "autonomous daily report failed",
          );
        }
        await pauseAutonomousForLocalDay(config, row.userId, localDate);
        await notifyChat(bot, row.chatId, row.telegramUserId, report);
      } catch (error) {
        logger.warn(
          {
            userId: row.userId,
            err: error instanceof Error ? error.message.slice(0, 120) : "pause",
          },
          "autonomous day-pause failed",
        );
      }
      continue;
    }
    if (!decision.run) continue;

    logger.info(
      { userId: row.userId, telegramUserId: row.telegramUserId },
      "autonomous tick started",
    );

    try {
      const settings = await getUserSettings(config, row.userId);
      const realizedPnlToday = await getRealizedPnlToday(config, row.userId, now);
      const halt = evaluateDayHalt({
        tradingEnabled: settings.tradingEnabled,
        realizedPnlToday,
        maxDailyLoss: settings.maxDailyLoss,
        dailyProfitTarget: settings.dailyProfitTarget,
        systemMaxDailyLoss: config.systemLimits.maxDailyLoss,
      });
      if (halt.halt) {
        const localDate = calendarDateInZone(now, "UTC");
        await pauseAutonomousForLocalDay(config, row.userId, localDate);
        logger.info(
          { userId: row.userId, code: halt.code, realizedPnlToday },
          "autonomous tick halted before scan",
        );
        await notifyChat(
          bot,
          row.chatId,
          row.telegramUserId,
          [
            "Autonomous trading paused for the UTC day.",
            "",
            formatDayHaltMessage({
              code: halt.code as DayHaltCode,
              realizedPnlToday,
              maxDailyLoss: settings.maxDailyLoss,
              dailyProfitTarget: settings.dailyProfitTarget,
            }),
          ].join("\n"),
        );
        continue;
      }
    } catch (error) {
      logger.warn(
        {
          userId: row.userId,
          err: error instanceof Error ? error.message.slice(0, 120) : "halt",
        },
        "autonomous preflight failed",
      );
    }

    let excludedMarketIds: string[] = [];
    try {
      const wallet = await findWallet(config, row.telegramUserId);
      if (wallet) {
        const managed = await manageOpenPositions({
          config,
          userId: row.userId,
          walletAddress: wallet.address,
          encryptedPrivateKey: wallet.encrypted_private_key,
          liveExecutionRequested: shouldRequestLiveExecution(
            row.executionMode,
            true,
          ),
        });
        excludedMarketIds = managed.excludedMarketIds;
        logger.info(
          {
            userId: row.userId,
            attempts: managed.attempts.length,
            excluded: excludedMarketIds.length,
            exited: managed.attempts.filter((a) => a.status === "exited").length,
            held: managed.attempts.filter((a) => a.status === "held").length,
            failed: managed.attempts.filter((a) => a.status === "failed").length,
          },
          "autonomous position management result",
        );
        const note = formatEarlyExitMessage(managed.attempts);
        if (note) {
          await notifyChat(bot, row.chatId, row.telegramUserId, note, row.userId);
        }
      } else {
        logger.info(
          { userId: row.userId },
          "autonomous position management skipped (no wallet)",
        );
      }
    } catch (error) {
      logger.warn(
        {
          userId: row.userId,
          err: errText(error, "manage"),
          stack: error instanceof Error ? error.stack?.slice(0, 400) : undefined,
        },
        "autonomous position management failed",
      );
    }

    try {
      logger.info(
        {
          userId: row.userId,
          excludeMarketIds: excludedMarketIds.length,
          liveRequested: shouldRequestLiveExecution(row.executionMode, true),
          stake: row.defaultStake,
        },
        "autonomous scan started",
      );
      const result = await runSafeTelegramTradeCycle(
        buildAutonomousTradeCycleInput(config, row, excludedMarketIds),
      );
      logger.info(
        {
          userId: row.userId,
          ok: result.ok,
          code: result.ok ? undefined : result.code,
          selected: result.ok ? result.marketScan.selected : result.marketScan?.selected,
          trades: result.ok ? (result.trades?.length ?? 0) : 0,
          executed: result.ok
            ? (result.trades ?? []).filter((t) => t.ok && t.execution?.ok).length
            : 0,
        },
        "autonomous scan result",
      );
      try {
        await markAutonomousScan(config, row.userId, row.timezone, now);
      } catch (error) {
        logger.warn(
          {
            userId: row.userId,
            err: errText(error, "mark"),
            stack: error instanceof Error ? error.stack?.slice(0, 400) : undefined,
          },
          "autonomous scan mark failed",
        );
      }
      if (!result.ok) {
        const haltCodes = new Set([
          "user_daily_loss_stop",
          "system_daily_loss_stop",
          "daily_profit_target_reached",
          "trading_disabled",
        ]);
        if (haltCodes.has(result.code)) {
          await pauseAutonomousForLocalDay(
            config,
            row.userId,
            calendarDateInZone(now, "UTC"),
          );
        }
        let failText = `Autonomous scan\n\n${result.code}`;
        try {
          failText = `Autonomous scan\n\n${formatUserFacingTradeFailure({
            code: result.code,
            reason: result.reason,
          })}`;
        } catch (error) {
          logger.warn(
            { userId: row.userId, err: errText(error, "format") },
            "autonomous failure format failed",
          );
        }
        await notifyChat(bot, row.chatId, row.telegramUserId, failText, row.userId);
      } else {
        logger.info(
          {
            userId: row.userId,
            tradeId: result.tradeId,
            executionOk: result.execution.ok,
            executionStatus: result.execution.ok ? result.execution.status : result.execution.code,
          },
          "autonomous execution result",
        );
        let okText = `Autonomous scan\n\nTrades: ${result.trades?.length ?? 1}`;
        try {
          okText = `Autonomous scan\n\n${formatMultiTradeReply({
            trades: result.trades ?? [],
            fallback: {
              tradeId: result.tradeId,
              intentSymbol: result.intentSymbol,
              decision: result.decision,
              stake: result.stake,
              execution: result.execution,
            },
            marketsLine: `selected: ${result.marketScan.selected ?? 0}`,
            executionMode: row.executionMode,
            explorerTxBaseUrl: config.explorerTxBaseUrl,
          })}`;
        } catch (error) {
          logger.warn(
            { userId: row.userId, err: errText(error, "format") },
            "autonomous success format failed",
          );
        }
        await notifyChat(bot, row.chatId, row.telegramUserId, okText, row.userId);
      }
      logger.info({ userId: row.userId, ok: result.ok }, "autonomous tick completed");
    } catch (error) {
      logger.warn(
        {
          userId: row.userId,
          err: errText(error, "tick"),
          stack: error instanceof Error ? error.stack?.slice(0, 800) : undefined,
        },
        "autonomous trade tick failed",
      );
    }

    try {
      const wallet = await findWallet(config, row.telegramUserId);
      if (!wallet) continue;
      const attempts = await runUserClaimScan({
        config,
        userId: row.userId,
        walletAddress: wallet.address,
        encryptedPrivateKey: wallet.encrypted_private_key,
      });
      const claimed = attempts.filter((a) => a.status === "claimed").length;
      const skipped = attempts.filter((a) => a.status === "skipped").length;
      const failed = attempts.filter((a) => a.status === "failed").length;
      logger.info(
        {
          userId: row.userId,
          scanned: attempts.length,
          claimed,
          skipped,
          failed,
        },
        "autonomous claim result",
      );
      if (claimed > 0) {
        await notifyChat(
          bot,
          row.chatId,
          row.telegramUserId,
          `Autonomous claim\n\n${formatClaimMessage(attempts)}`,
          row.userId,
        );
      }
    } catch (error) {
      logger.warn(
        {
          userId: row.userId,
          err: error instanceof Error ? error.message.slice(0, 160) : "claim",
        },
        "autonomous claim tick failed",
      );
    }
  }
}

export function startAutonomousLoop(
  bot: Bot,
  config: AppConfig,
): { stop: () => void } {
  const timer = setInterval(() => {
    void runAutonomousTick(bot, config);
  }, INTERVAL_MS);
  timer.unref?.();
  logger.info({ intervalMs: INTERVAL_MS }, "autonomous loop started");
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

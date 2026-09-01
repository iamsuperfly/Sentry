import type { Bot } from "grammy";
import type { AppConfig } from "../config.ts";
import { formatClaimMessage, runUserClaimScan } from "./claim-positions.ts";
import { logger } from "./logger.ts";
import { findWallet } from "./supabase.ts";
import { formatMultiTradeReply } from "./telegram-multi-trade-reply.ts";
import { formatUserFacingTradeFailure } from "./telegram-trade-format.ts";
import { shouldRequestLiveExecution } from "./telegram-settings.ts";
import { runTelegramTradeCycle } from "./trade-orchestration.ts";
import {
  listAutonomousCandidates,
  markAutonomousScan,
  pauseAutonomousForLocalDay,
  shouldRunAutonomousTick,
} from "./autonomous-state.ts";
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

const INTERVAL_MS = 15 * 60 * 1000;

function notifyChat(bot: Bot, chatId: number | null, telegramUserId: number, text: string) {
  const target = chatId && Number.isFinite(chatId) ? chatId : telegramUserId;
  if (!target) return Promise.resolve();
  return bot.api.sendMessage(target, text, {
    link_preview_options: { is_disabled: true },
  });
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

    const identity = {
      id: row.telegramUserId,
      username: undefined,
      first_name: "trader",
    };
    try {
      const result = await runTelegramTradeCycle({
        config,
        identity,
        liveExecutionRequested: shouldRequestLiveExecution(
          row.executionMode,
          true,
        ),
        stake: row.defaultStake,
      });
      await markAutonomousScan(config, row.userId, row.timezone, now);
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
        await notifyChat(
          bot,
          row.chatId,
          row.telegramUserId,
          `Autonomous scan\n\n${formatUserFacingTradeFailure({
            code: result.code,
            reason: result.reason,
          })}`,
        );
      } else {
        await notifyChat(
          bot,
          row.chatId,
          row.telegramUserId,
          `Autonomous scan\n\n${formatMultiTradeReply({
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
          })}`,
        );
      }
    } catch (error) {
      logger.warn(
        {
          userId: row.userId,
          err: error instanceof Error ? error.message.slice(0, 160) : "tick",
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
      if (claimed > 0) {
        await notifyChat(
          bot,
          row.chatId,
          row.telegramUserId,
          `Autonomous claim\n\n${formatClaimMessage(attempts)}`,
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

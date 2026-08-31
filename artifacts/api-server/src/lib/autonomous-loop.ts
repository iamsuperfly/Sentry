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

const INTERVAL_MS = 15 * 60 * 1000;

function notifyChat(bot: Bot, chatId: number | null, telegramUserId: number, text: string) {
  const target = chatId && Number.isFinite(chatId) ? chatId : telegramUserId;
  if (!target) return Promise.resolve();
  return bot.api.sendMessage(target, text, {
    link_preview_options: { is_disabled: true },
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
        await pauseAutonomousForLocalDay(config, row.userId, localDate);
        await notifyChat(
          bot,
          row.chatId,
          row.telegramUserId,
          "Autonomous trading stopped for the day.\n\nSend /trade or /auto on to start again tomorrow.",
        );
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

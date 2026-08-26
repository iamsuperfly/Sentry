/**
 * Same-process finalization worker for the existing Telegram bot runtime.
 * Does NOT start a second grammY polling instance — uses bot.api only.
 */

import type { Bot } from "grammy";
import type { AppConfig } from "../config";
import { logger } from "../lib/logger";
import {
  applyMarketResolveFinalization,
  buildFinalizationTelegramText,
  claimFinalizationNotification,
  listOpenTradesForFinalization,
  listTerminalTradesNeedingNotification,
} from "../lib/trade-finalization";

const TICK_MS = 45_000;

export function startFinalizationLoop(
  bot: Bot,
  config: AppConfig,
): { stop: () => void } {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const open = await listOpenTradesForFinalization(config, { limit: 40 });
      for (const trade of open) {
        try {
          await applyMarketResolveFinalization(config, trade, null);
        } catch (error) {
          logger.error(
            {
              err: error instanceof Error ? error.message : String(error),
              tradeId: trade.id,
            },
            "Market-resolve finalization failed",
          );
        }
      }

      const terminal = await listTerminalTradesNeedingNotification(config, {
        limit: 40,
      });
      for (const trade of terminal) {
        if (!trade.telegramUserId) continue;
        try {
          const claimed = await claimFinalizationNotification(config, {
            tradeId: trade.id,
            userId: trade.userId,
          });
          if (!claimed) continue;
          const text = buildFinalizationTelegramText(
            trade,
            config.explorerTxBaseUrl,
          );
          await bot.api.sendMessage(trade.telegramUserId, text, {
            link_preview_options: { is_disabled: true },
          });
        } catch (error) {
          logger.error(
            {
              err: error instanceof Error ? error.message : String(error),
              tradeId: trade.id,
            },
            "Finalization notification failed",
          );
        }
      }
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Finalization tick failed",
      );
    }
  }

  const handle = setInterval(() => {
    void tick();
  }, TICK_MS);
  // First pass shortly after boot (does not block startup).
  setTimeout(() => {
    void tick();
  }, 8_000);

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

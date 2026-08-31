import type { Bot } from "grammy";
import type { AppConfig } from "../config";
import { ensureUser, findWallet } from "../lib/supabase";
import { getLeaderboardMessage } from "../lib/leaderboard-persist";
import {
  clearAutonomousPause,
  setAutonomousEnabled,
  saveUserTimezone,
} from "../lib/autonomous-state";
import { getUserSettingsForTelegram } from "../lib/trade-persistence";
import {
  isValidIanaTimezone,
  normalizeTimezone,
} from "../lib/user-timezone";

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return /key|secret|token|credential|supabase/i.test(message)
    ? "An internal error occurred."
    : message.slice(0, 180);
}

export function registerPhaseCommands(bot: Bot, config: AppConfig): void {
  bot.command("leaderboard", async (ctx) => {
    try {
      if (!ctx.from) return;
      const userId = await ensureUser(config, ctx.from);
      const settings = await getUserSettingsForTelegram(config, {
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      });
      const text = await getLeaderboardMessage(
        config,
        userId,
        settings.timezone,
      );
      await ctx.reply(text);
    } catch (error) {
      await ctx.reply(`Unable to load leaderboard.\n\nReason: ${safeError(error)}`);
    }
  });

  bot.command("auto", async (ctx) => {
    try {
      if (!ctx.from) return;
      const raw = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase();
      const identity = {
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };
      const settings = await getUserSettingsForTelegram(config, identity);
      if (!raw || raw === "status") {
        await ctx.reply(
          [
            `Autonomous trading: ${settings.autonomousEnabled ? "ON" : "OFF"}`,
            settings.autonomousPausedAt
              ? "Status: paused for the day. Send /trade or /auto on to resume."
              : "Status: active when ON.",
            "Auto-claim is tied to this toggle.",
            "",
            "/auto on — enable 15-minute scans",
            "/auto off — disable",
          ].join("\n"),
        );
        return;
      }
      if (raw === "on" || raw === "off") {
        const enabled = raw === "on";
        if (enabled && !settings.tradingEnabled) {
          await ctx.reply(
            "Enable trading first with /settings trading on, then /auto on.",
          );
          return;
        }
        await setAutonomousEnabled(
          config,
          settings.userId,
          enabled,
          ctx.chat?.id ?? ctx.from.id,
        );
        await ctx.reply(
          enabled
            ? "Autonomous trading ON.\nScans every 15 minutes using the same /trade pipeline.\nAutomatic claiming is also ON.\nStops at your local midnight until you send /trade or /auto on."
            : "Autonomous trading OFF.\nAutomatic claiming is also OFF.\nManual /trade and /claim still work.",
        );
        return;
      }
      await ctx.reply("Usage: /auto on|off|status");
    } catch (error) {
      await ctx.reply(`Unable to update autonomous trading.\n\nReason: ${safeError(error)}`);
    }
  });

  bot.command("timezone", async (ctx) => {
    try {
      if (!ctx.from) return;
      const raw = (typeof ctx.match === "string" ? ctx.match : "").trim();
      const identity = {
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };
      const settings = await getUserSettingsForTelegram(config, identity);
      if (!raw) {
        await ctx.reply(
          `Your timezone: ${settings.timezone}\n\nDaily PnL, faucet, loss limits, leaderboard today, and autonomous cutoff use this local midnight.\nChange with /timezone Africa/Lagos`,
        );
        return;
      }
      if (!isValidIanaTimezone(raw)) {
        await ctx.reply(
          `Unknown timezone "${raw}". Use an IANA name such as Africa/Lagos or America/New_York.`,
        );
        return;
      }
      const saved = await saveUserTimezone(config, settings.userId, raw);
      await ctx.reply(`Timezone set to ${saved} (${normalizeTimezone(saved)}).`);
    } catch (error) {
      await ctx.reply(`Unable to update timezone.\n\nReason: ${safeError(error)}`);
    }
  });
}

export async function resumeAutonomousIfEnabled(
  config: AppConfig,
  userId: string,
  chatId: number,
): Promise<void> {
  await clearAutonomousPause(config, userId, chatId);
}

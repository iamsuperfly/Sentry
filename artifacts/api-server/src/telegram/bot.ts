import { Bot, type Context } from "grammy";
import type { AppConfig } from "../config";
import { getSupabaseClient } from "../lib/supabase";
import { logger } from "../lib/logger";

const HELP_TEXT = [
  "DreamDEX Event Contracts bot",
  "",
  "Available commands:",
  "/start — register your Telegram account",
  "/help — show this help message",
  "/status — show bot and account status",
  "",
  "Trading is not enabled yet. This bot currently runs on Somnia Shannon testnet only.",
].join("\n");

function telegramUserId(ctx: Context): number | undefined {
  return ctx.from?.id;
}

async function registerUser(ctx: Context, config: AppConfig): Promise<void> {
  const from = ctx.from;
  if (!from) {
    await ctx.reply("I could not identify your Telegram account. Please try again.");
    return;
  }

  const supabase = getSupabaseClient(config);
  const { data: user, error: userError } = await supabase
    .from("telegram_users")
    .upsert(
      {
        telegram_user_id: from.id,
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        last_name: from.last_name ?? null,
        is_active: true,
      },
      { onConflict: "telegram_user_id" },
    )
    .select("id")
    .single();

  if (userError || !user) {
    logger.error({ err: userError, telegramUserId: from.id }, "Failed to register Telegram user");
    await ctx.reply("I could not save your account yet. Please try again shortly.");
    return;
  }

  const { error: settingsError } = await supabase
    .from("user_settings")
    .upsert({ user_id: user.id }, { onConflict: "user_id" });

  if (settingsError) {
    logger.error(
      { err: settingsError, telegramUserId: from.id },
      "Failed to create default Telegram user settings",
    );
    await ctx.reply("Your account was registered, but I could not create its settings yet.");
    return;
  }

  await ctx.reply(
    "Welcome. Your testnet account is registered.\n\nTrading is not enabled yet. Use /help to see available commands.",
  );
}

async function showStatus(ctx: Context, config: AppConfig): Promise<void> {
  const id = telegramUserId(ctx);
  if (id === undefined) {
    await ctx.reply("I could not identify your Telegram account. Please try again.");
    return;
  }

  const { data, error } = await getSupabaseClient(config)
    .from("telegram_users")
    .select("is_active, created_at")
    .eq("telegram_user_id", id)
    .maybeSingle();

  if (error) {
    logger.error({ err: error, telegramUserId: id }, "Failed to load Telegram user status");
    await ctx.reply("Status is temporarily unavailable. Please try again shortly.");
    return;
  }

  const accountStatus = data?.is_active ? "registered and active" : "not active";
  await ctx.reply(
    [
      "Bot status: online",
      "Network: Somnia Shannon testnet (chain ID 50312)",
      `Account: ${accountStatus}`,
      "Trading: not enabled yet",
    ].join("\n"),
  );
}

export function createTelegramBot(config: AppConfig): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.command("start", async (ctx) => {
    await registerUser(ctx, config);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("status", async (ctx) => {
    await showStatus(ctx, config);
  });

  bot.on("message:text", async (ctx) => {
    await ctx.reply("I do not recognize that command. Use /help to see what is available.");
  });

  bot.catch((error) => {
    logger.error({ err: error.error, updateId: error.ctx.update.update_id }, "Telegram update failed");
  });

  return bot;
}

export function startTelegramBot(config: AppConfig): Bot {
  const bot = createTelegramBot(config);

  void bot.start({
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username }, "Telegram bot polling started");
    },
  });

  return bot;
}
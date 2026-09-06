import type { Context } from "grammy";
import type { AppConfig } from "../config";
import { ensureUser, findWallet } from "../lib/supabase";
import { getUserSettingsForTelegram } from "../lib/trade-persistence";
import {
  formatHistoryMessage,
  listHistoryForDisplay,
} from "../lib/position-display";
import { getLeaderboardMessage } from "../lib/leaderboard-persist";
import { decryptPrivateKey } from "../lib/wallet-crypto";
import {
  helpKeyboard,
  privateKeyRevealKeyboard,
  privateKeyWarnKeyboard,
} from "./ui-keyboards";

function identityFrom(ctx: Context) {
  const from = ctx.from!;
  return {
    id: from.id,
    username: from.username,
    first_name: from.first_name,
    last_name: from.last_name,
  };
}

export async function showHistory(ctx: Context, config: AppConfig) {
  const userId = await ensureUser(config, ctx.from!);
  const history = await listHistoryForDisplay(config, userId, 8);
  await ctx.reply(formatHistoryMessage(history, config.explorerTxBaseUrl), {
    link_preview_options: { is_disabled: true },
    reply_markup: helpKeyboard(),
  });
}

export async function showLeaderboard(ctx: Context, config: AppConfig) {
  const settings = await getUserSettingsForTelegram(config, identityFrom(ctx));
  const text = await getLeaderboardMessage(config, settings.userId);
  await ctx.reply(text, { reply_markup: helpKeyboard() });
}

export async function warnPrivateKey(ctx: Context) {
  await ctx.reply(
    [
      "Private key",
      "",
      "Anyone with this key can take the funds in this wallet.",
      "Do not share it. Do not screenshot it.",
      "The next message will show the key and delete itself after 60 seconds.",
    ].join("\n"),
    { reply_markup: privateKeyWarnKeyboard() },
  );
}

export function buildPrivateKeyRevealText(key: string): string {
  return [
    "Your private key",
    "",
    `<code>${key}</code>`,
    "",
    "Use COPY KEY, or tap and hold the key to copy.",
    "This message deletes in 60 seconds.",
  ].join("\n");
}

export async function revealPrivateKey(ctx: Context, config: AppConfig) {
  const wallet = await findWallet(config, ctx.from!.id);
  if (!wallet) {
    await ctx.reply("Tap Start to create your wallet first.", {
      reply_markup: helpKeyboard(),
    });
    return;
  }
  const key = decryptPrivateKey(config, wallet.encrypted_private_key);
  const sent = await ctx.reply(buildPrivateKeyRevealText(key), {
    parse_mode: "HTML",
    protect_content: true,
    reply_markup: privateKeyRevealKeyboard(key),
  });
  setTimeout(() => {
    ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => undefined);
  }, 60_000);
}

export async function hidePrivateKey(ctx: Context) {
  try {
    await ctx.deleteMessage();
  } catch {
    await ctx.reply("Key message hidden.", { reply_markup: helpKeyboard() });
    return;
  }
  await ctx.reply("Key hidden.", { reply_markup: helpKeyboard() });
}

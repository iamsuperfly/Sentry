import type { Bot } from "grammy";
import type { AppConfig } from "../config";
import { ensureUser, findWallet } from "../lib/supabase";
import {
  formatClaimMessage,
  runUserClaimScan,
} from "../lib/claim-positions";

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return /key|secret|token|credential|supabase/i.test(message)
    ? "An internal error occurred."
    : message;
}

export function registerClaimCommand(bot: Bot, config: AppConfig): void {
  bot.command("claim", async (ctx) => {
    try {
      if (!ctx.from) return;
      const wallet = await findWallet(config, ctx.from.id);
      if (!wallet) {
        await ctx.reply("You do not have a wallet yet. Use /start first.");
        return;
      }
      const userId = await ensureUser(config, ctx.from);
      await ctx.reply("Scanning settled positions for claimable winnings…");
      const attempts = await runUserClaimScan({
        config,
        userId,
        walletAddress: wallet.address,
        encryptedPrivateKey: wallet.encrypted_private_key,
      });
      await ctx.reply(formatClaimMessage(attempts), {
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      await ctx.reply(
        `Unable to claim positions.\n\nReason: ${safeError(error)}`,
      );
    }
  });
}

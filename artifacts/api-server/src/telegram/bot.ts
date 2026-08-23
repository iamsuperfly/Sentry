import { Bot, InlineKeyboard, type Context } from "grammy";
import type { AppConfig } from "../config";
import { logger } from "../lib/logger";
import { balances, createWallet, explorer, faucet, receipt, sponsor } from "../lib/blockchain";
import {
  createTransaction,
  ensureUser,
  findWallet,
  getSupabaseClient,
  saveWallet,
  updateTransaction,
} from "../lib/supabase";
import { decryptPrivateKey, encryptPrivateKey } from "../lib/wallet-crypto";

const active = new Set<number>();
const lastStart = new Map<number, number>();
const cooldownMs = 30_000;

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return /key|secret|token|credential|supabase/i.test(message)
    ? "A secure service configuration error occurred."
    : message.slice(0, 180);
}

function link(config: AppConfig, hash: string) {
  return new InlineKeyboard().url("View transaction", explorer(config, hash));
}

async function confirm(
  ctx: Context,
  config: AppConfig,
  transactionId: string,
  hash: `0x${string}`,
  message: string | (() => Promise<string>),
) {
  try {
    const result = await receipt(config, hash);
    await updateTransaction(config, transactionId, {
      transaction_hash: hash,
      status: result.status,
      block_number: result.blockNumber,
      confirmed_at: result.status === "confirmed" ? new Date().toISOString() : null,
      error_message: result.status === "failed" ? "Transaction reverted on-chain." : null,
    });
    if (result.status === "failed") {
      await ctx.reply(`❌ Transaction failed.\n\nReason: Transaction reverted on-chain.\nTransaction: ${hash}`, {
        reply_markup: link(config, hash),
      });
      return false;
    }
    const text = typeof message === "function" ? await message() : message;
    await ctx.reply(`${text}\n\nTransaction confirmed.\n\nTransaction: ${hash}`, {
      reply_markup: link(config, hash),
    });
    return true;
  } catch (error) {
    await updateTransaction(config, transactionId, {
      transaction_hash: hash,
      status: "failed",
      error_message: "Confirmation timed out or RPC became unavailable.",
    }).catch(() => undefined);
    await ctx.reply(`❌ Transaction failed.\n\nReason: ${safeError(error)}\nTransaction: ${hash}`, {
      reply_markup: link(config, hash),
    });
    return false;
  }
}

async function start(ctx: Context, config: AppConfig) {
  const from = ctx.from;
  if (!from) return;
  if ((lastStart.get(from.id) ?? 0) + cooldownMs > Date.now()) {
    await ctx.reply("Please wait a moment before trying again.");
    return;
  }
  if (active.has(from.id)) {
    await ctx.reply("Your onboarding is already in progress.");
    return;
  }
  lastStart.set(from.id, Date.now());
  active.add(from.id);
  try {
    const existing = await findWallet(config, from.id);
    if (existing) {
      await ctx.reply(`You already have a dedicated wallet.\n\nAddress: ${existing.address}\n\nUse /status to check balances.`);
      return;
    }
    const userId = await ensureUser(config, from);
    const created = createWallet();
    const wallet = await saveWallet(config, {
      userId,
      address: created.address,
      encryptedPrivateKey: encryptPrivateKey(config, created.privateKey),
    });
    await ctx.reply(
      `Your dedicated wallet is ready.\n\nAddress: ${wallet.address}\n\nI’ll sponsor ${config.initialGasSponsorAmount} STT for gas, then request ${config.initialTusdcFaucetAmount} tUSDC.`,
    );

    const fundingId = await createTransaction(config, {
      userId,
      walletAddress: wallet.address,
      type: "INITIAL_STT_SPONSOR",
      amount: config.initialGasSponsorAmount,
      tokenSymbol: "STT",
      toAddress: wallet.address,
    });
    const funding = await sponsor(config, wallet.address);
    await updateTransaction(config, fundingId, { transaction_hash: funding.hash, status: "submitted" });
    await ctx.reply(`⏳ Sending ${config.initialGasSponsorAmount} STT to your wallet...\n\nTransaction submitted.\n\nTx: ${funding.hash}`, {
      reply_markup: link(config, funding.hash),
    });
    if (!(await confirm(ctx, config, fundingId, funding.hash, `✅ ${config.initialGasSponsorAmount} STT received.`))) return;

    const faucetId = await createTransaction(config, {
      userId,
      walletAddress: wallet.address,
      type: "TUSDC_FAUCET",
      amount: config.initialTusdcFaucetAmount,
      tokenSymbol: "tUSDC",
      fromAddress: wallet.address,
      toAddress: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
    });
    const faucetTx = await faucet(config, wallet.encrypted_private_key);
    await updateTransaction(config, faucetId, { transaction_hash: faucetTx.hash, status: "submitted" });
    await ctx.reply(`⏳ Requesting test USDC...\n\nTransaction submitted.\n\nTx: ${faucetTx.hash}`, {
      reply_markup: link(config, faucetTx.hash),
    });
    if (await confirm(ctx, config, faucetId, faucetTx.hash, async () => {
      const current = await balances(config, wallet.address);
      return `✅ Test USDC received.\n\nAmount: ${config.initialTusdcFaucetAmount} tUSDC\nBalance: ${current.tusdc} tUSDC`;
    })) {
      await ctx.reply("Your wallet is ready for future DreamDEX trading. Trading is not enabled yet.");
    }
  } catch (error) {
    await ctx.reply(`❌ Onboarding could not be completed.\n\nReason: ${safeError(error)}`);
  } finally {
    active.delete(from.id);
  }
}

export function createTelegramBot(config: AppConfig): Bot {
  const bot = new Bot(config.telegramBotToken);
  bot.command("start", (ctx) => start(ctx, config));
  bot.command("help", (ctx) => ctx.reply("DreamDEX Event Contracts bot\n\n/start — create your Somnia wallet\n/status — view live balances\n/privatekey — export your private key\n\nTrading is not enabled yet."));
  bot.command("status", async (ctx) => {
    try {
      if (!ctx.from) return;
      const wallet = await findWallet(config, ctx.from.id);
      if (!wallet) return void await ctx.reply("You do not have a wallet yet. Use /start to begin.");
      const current = await balances(config, wallet.address);
      await ctx.reply(`Wallet status: ready\n\nAddress: ${wallet.address}\nNetwork: Somnia Shannon (50312)\nSTT: ${current.stt}\ntUSDC: ${current.tusdc}`);
    } catch (error) {
      await ctx.reply(`Unable to read live balances.\n\nReason: ${safeError(error)}`);
    }
  });
  bot.command("privatekey", async (ctx) => {
    try {
      if (!ctx.from) return;
      const wallet = await findWallet(config, ctx.from.id);
      if (!wallet) return void await ctx.reply("Create your wallet first with /start.");
      const key = decryptPrivateKey(config, wallet.encrypted_private_key);
      const sent = await ctx.reply(`Your private key (keep it secret):\n\n${key}\n\nThis message will be deleted in 60 seconds.`, { protect_content: true });
      setTimeout(() => ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => undefined), 60_000);
    } catch (error) {
      await ctx.reply(`Unable to retrieve the private key.\n\nReason: ${safeError(error)}`);
    }
  });
  bot.on("message:text", (ctx) => ctx.reply("I do not recognize that command. Use /help."));
  bot.catch((error) => logger.error({ err: safeError(error.error), updateId: error.ctx.update.update_id }, "Telegram update failed"));
  return bot;
}

export function startTelegramBot(config: AppConfig): Bot {
  const bot = createTelegramBot(config);
  void bot.start({ onStart: (info) => logger.info({ username: info.username }, "Telegram bot polling started") })
    .catch((error) => logger.error({ err: safeError(error) }, "Telegram polling stopped"));
  return bot;
}
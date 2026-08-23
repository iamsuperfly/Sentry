import { Bot, InlineKeyboard, type Context } from "grammy";
import type { AppConfig } from "../config";
import { logger } from "../lib/logger";
import {
  balances,
  createWallet,
  explorer,
  faucet,
  inspectReceipt,
  receipt,
  sponsor,
} from "../lib/blockchain";
import { parseFaucetAmount } from "../lib/faucet";
import {
  createTransaction,
  ensureUser,
  findWallet,
  getSupabaseClient,
  getOnboardingTransactions,
  getFaucetAllowance,
  reserveFaucetTransaction,
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
      confirmed_at:
        result.status === "confirmed" ? new Date().toISOString() : null,
      error_message:
        result.status === "failed" ? "Transaction reverted on-chain." : null,
    });
    if (result.status === "failed") {
      await ctx.reply(
        `❌ Transaction failed.\n\nReason: Transaction reverted on-chain.\nTransaction: ${hash}`,
        {
          reply_markup: link(config, hash),
        },
      );
      return false;
    }
    const text = typeof message === "function" ? await message() : message;
    await ctx.reply(
      `${text}\n\nTransaction confirmed.\n\nTransaction: ${hash}`,
      {
        reply_markup: link(config, hash),
      },
    );
    return true;
  } catch (error) {
    await updateTransaction(config, transactionId, {
      transaction_hash: hash,
      status: "submitted",
      error_message:
        "Confirmation is still pending or the RPC became unavailable.",
    }).catch(() => undefined);
    await ctx.reply(
      `❌ Transaction failed.\n\nReason: ${safeError(error)}\nTransaction: ${hash}`,
      {
        reply_markup: link(config, hash),
      },
    );
    return false;
  }
}

async function runFunding(
  ctx: Context,
  config: AppConfig,
  userId: string,
  wallet: {
    address: string;
    encrypted_private_key: string;
  },
) {
  const transactions = await getOnboardingTransactions(
    config,
    userId,
    wallet.address,
  );

  async function reconcile(type: "INITIAL_STT_SPONSOR" | "TUSDC_FAUCET") {
    const records = transactions.filter(
      (transaction) => transaction.type === type,
    );
    for (const transaction of records) {
      if (transaction.status === "confirmed") continue;
      if (!transaction.transaction_hash) {
        if (transaction.status === "pending") {
          await updateTransaction(config, transaction.id, {
            status: "failed",
            error_message: "No blockchain hash was recorded; safe to retry.",
          });
          transaction.status = "failed";
        }
        continue;
      }
      const inspected = await inspectReceipt(
        config,
        transaction.transaction_hash,
      );
      if (inspected) {
        await updateTransaction(config, transaction.id, {
          status: inspected.status,
          block_number: inspected.blockNumber,
          confirmed_at:
            inspected.status === "confirmed" ? new Date().toISOString() : null,
          error_message:
            inspected.status === "failed"
              ? "Transaction reverted on-chain."
              : null,
        });
        transaction.status = inspected.status;
      }
    }
  }

  await reconcile("INITIAL_STT_SPONSOR");

  const refreshed = await balances(config, wallet.address);
  const fundingRecords = transactions.filter(
    (transaction) => transaction.type === "INITIAL_STT_SPONSOR",
  );
  const confirmedFunding = fundingRecords.find(
    (transaction) => transaction.status === "confirmed",
  );
  const pendingFunding = fundingRecords.find(
    (transaction) =>
      transaction.transaction_hash &&
      (transaction.status === "pending" || transaction.status === "submitted"),
  );
  if (
    !confirmedFunding &&
    parseFloat(refreshed.stt) < parseFloat(config.initialGasSponsorAmount) &&
    pendingFunding?.transaction_hash
  ) {
    await ctx.reply(
      `⏳ Your STT sponsorship is still pending.\n\nTransaction: ${pendingFunding.transaction_hash}`,
      {
        reply_markup: link(config, pendingFunding.transaction_hash),
      },
    );
    return;
  }
  if (
    !confirmedFunding &&
    parseFloat(refreshed.stt) < parseFloat(config.initialGasSponsorAmount)
  ) {
    const fundingId = await createTransaction(config, {
      userId,
      walletAddress: wallet.address,
      type: "INITIAL_STT_SPONSOR",
      amount: config.initialGasSponsorAmount,
      tokenSymbol: "STT",
      toAddress: wallet.address,
    });
    try {
      const funding = await sponsor(config, wallet.address);
      await updateTransaction(config, fundingId, {
        transaction_hash: funding.hash,
        status: "submitted",
      });
      await ctx.reply(
        `⏳ Sending ${config.initialGasSponsorAmount} STT...\n\nTransaction: ${funding.hash}`,
        {
          reply_markup: link(config, funding.hash),
        },
      );
      if (
        !(await confirm(
          ctx,
          config,
          fundingId,
          funding.hash,
          `✅ ${config.initialGasSponsorAmount} STT received.`,
        ))
      )
        return;
    } catch (error) {
      await updateTransaction(config, fundingId, {
        status: "failed",
        error_message: safeError(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  const finalBalance = await balances(config, wallet.address);
  await ctx.reply(
    `✅ Wallet setup is complete.\n\nAddress: ${wallet.address}\nSTT: ${finalBalance.stt}\ntUSDC: ${finalBalance.tusdc}\n\nYou can request tUSDC with /faucet <amount>. Trading is not enabled yet.`,
  );
}

async function reconcileFaucetTransactions(
  config: AppConfig,
  userId: string,
  walletAddress: string,
) {
  const transactions = await getOnboardingTransactions(
    config,
    userId,
    walletAddress,
  );
  for (const transaction of transactions.filter(
    (item) => item.type === "TUSDC_FAUCET",
  )) {
    if (transaction.status === "confirmed" || !transaction.transaction_hash) {
      if (transaction.status === "pending" && !transaction.transaction_hash) {
        await updateTransaction(config, transaction.id, {
          status: "failed",
          error_message:
            "No blockchain hash was recorded; faucet allowance released.",
        });
      }
      continue;
    }
    const inspected = await inspectReceipt(
      config,
      transaction.transaction_hash,
    );
    if (inspected) {
      await updateTransaction(config, transaction.id, {
        status: inspected.status,
        block_number: inspected.blockNumber,
        confirmed_at:
          inspected.status === "confirmed" ? new Date().toISOString() : null,
        error_message:
          inspected.status === "failed"
            ? "Transaction reverted on-chain; faucet allowance released."
            : null,
      });
    }
  }
}

async function requestFaucet(ctx: Context, config: AppConfig) {
  if (!ctx.from) return;
  const rawAmount = typeof ctx.match === "string" ? ctx.match.trim() : "";
  let amount: string;
  try {
    amount = parseFaucetAmount(rawAmount);
  } catch (error) {
    await ctx.reply(
      `❌ ${safeError(error)}\n\nDaily allowance: 500 tUSDC. Use /faucet <amount>.`,
    );
    return;
  }

  try {
    const wallet = await findWallet(config, ctx.from.id);
    if (!wallet) {
      await ctx.reply("You do not have a wallet yet. Use /start first.");
      return;
    }
    const userId = await ensureUser(config, ctx.from);
    await reconcileFaucetTransactions(config, userId, wallet.address);
    const reservation = await reserveFaucetTransaction(config, {
      userId,
      walletAddress: wallet.address,
      amount,
    });

    try {
      const faucetTx = await faucet(
        config,
        wallet.encrypted_private_key,
        amount,
      );
      await updateTransaction(config, reservation.transaction_id, {
        transaction_hash: faucetTx.hash,
        status: "submitted",
      });
      await ctx.reply(
        `⏳ Requesting ${amount} tUSDC.\n\nRemaining today: ${reservation.remaining} tUSDC\nTransaction: ${faucetTx.hash}`,
        { reply_markup: link(config, faucetTx.hash) },
      );
      await confirm(
        ctx,
        config,
        reservation.transaction_id,
        faucetTx.hash,
        async () => {
          const current = await balances(config, wallet.address);
          return `✅ ${amount} tUSDC received.\n\nBalance: ${current.tusdc} tUSDC\nRemaining today: ${reservation.remaining} tUSDC`;
        },
      );
    } catch (error) {
      await updateTransaction(config, reservation.transaction_id, {
        status: "failed",
        error_message: safeError(error),
      }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await ctx.reply(
      `❌ Faucet request was not completed.\n\nReason: ${safeError(error)}`,
    );
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
    const userId = await ensureUser(config, from);
    const wallet =
      existing ??
      (() => {
        const created = createWallet();
        return {
          ...created,
          encrypted_private_key: encryptPrivateKey(config, created.privateKey),
        };
      })();
    const saved =
      existing ??
      (await saveWallet(config, {
        userId,
        address: wallet.address,
        encryptedPrivateKey: wallet.encrypted_private_key,
      }));
    await ctx.reply(
      existing
        ? `Resuming funding for your existing wallet.\n\nAddress: ${saved.address}`
        : `Your dedicated wallet is ready.\n\nAddress: ${saved.address}`,
    );
    await runFunding(ctx, config, userId, saved);
  } catch (error) {
    await ctx.reply(
      `❌ Onboarding could not be completed.\n\nReason: ${safeError(error)}`,
    );
  } finally {
    active.delete(from.id);
  }
}

export function createTelegramBot(config: AppConfig): Bot {
  const bot = new Bot(config.telegramBotToken);
  bot.command("start", (ctx) => start(ctx, config));
  bot.command("fund", async (ctx) => {
    if (!ctx.from || active.has(ctx.from.id)) return;
    active.add(ctx.from.id);
    try {
      const wallet = await findWallet(config, ctx.from.id);
      if (!wallet)
        return void (await ctx.reply(
          "You do not have a wallet yet. Use /start first.",
        ));
      const userId = await ensureUser(config, ctx.from);
      await runFunding(ctx, config, userId, wallet);
    } catch (error) {
      await ctx.reply(
        `❌ Funding recovery could not be completed.\n\nReason: ${safeError(error)}`,
      );
    } finally {
      if (ctx.from) active.delete(ctx.from.id);
    }
  });
  bot.command("faucet", (ctx) => requestFaucet(ctx, config));
  bot.command("help", (ctx) =>
    ctx.reply(
      "DreamDEX Event Contracts bot\n\n/start — create/resume wallet and gas funding\n/faucet <amount> — request tUSDC, up to 500/day\n/status — wallet balances and faucet allowance\n/privatekey — export your private key\n/fund — recover interrupted STT funding\n\nThe faucet allowance resets at the next UTC day. Trading is not enabled yet.",
    ),
  );
  bot.command("status", async (ctx) => {
    try {
      if (!ctx.from) return;
      const wallet = await findWallet(config, ctx.from.id);
      if (!wallet)
        return void (await ctx.reply(
          "You do not have a wallet yet. Use /start to begin.",
        ));
      await reconcileFaucetTransactions(config, wallet.user_id, wallet.address);
      const [current, allowance] = await Promise.all([
        balances(config, wallet.address),
        getFaucetAllowance(config, wallet.user_id),
      ]);
      await ctx.reply(
        `Wallet status: ready\n\nAddress: ${wallet.address}\nNetwork: Somnia Shannon (50312)\nSTT: ${current.stt}\ntUSDC: ${current.tusdc}\n\nFaucet today: ${allowance.consumed} / 500 tUSDC\nRemaining: ${allowance.remaining} tUSDC\nAllowance resets at the next UTC day.`,
      );
    } catch (error) {
      await ctx.reply(
        `Unable to read live balances.\n\nReason: ${safeError(error)}`,
      );
    }
  });
  bot.command("privatekey", async (ctx) => {
    try {
      if (!ctx.from) return;
      const wallet = await findWallet(config, ctx.from.id);
      if (!wallet)
        return void (await ctx.reply("Create your wallet first with /start."));
      const key = decryptPrivateKey(config, wallet.encrypted_private_key);
      const sent = await ctx.reply(
        `Your private key (keep it secret):\n\n${key}\n\nThis message will be deleted in 60 seconds.`,
        { protect_content: true },
      );
      setTimeout(
        () =>
          ctx.api
            .deleteMessage(sent.chat.id, sent.message_id)
            .catch(() => undefined),
        60_000,
      );
    } catch (error) {
      await ctx.reply(
        `Unable to retrieve the private key.\n\nReason: ${safeError(error)}`,
      );
    }
  });
  bot.on("message:text", (ctx) =>
    ctx.reply("I do not recognize that command. Use /help."),
  );
  bot.catch((error) =>
    logger.error(
      { err: safeError(error.error), updateId: error.ctx.update.update_id },
      "Telegram update failed",
    ),
  );
  return bot;
}

export function startTelegramBot(config: AppConfig): Bot {
  const bot = createTelegramBot(config);
  void bot
    .start({
      onStart: (info) =>
        logger.info(
          { username: info.username },
          "Telegram bot polling started",
        ),
    })
    .catch((error) =>
      logger.error({ err: safeError(error) }, "Telegram polling stopped"),
    );
  return bot;
}

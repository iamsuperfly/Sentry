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
  getOnboardingTransactions,
  getFaucetAllowance,
  reserveFaucetTransaction,
  saveWallet,
  updateTransaction,
} from "../lib/supabase";
import { decryptPrivateKey, encryptPrivateKey } from "../lib/wallet-crypto";
import { runTelegramTradeCycle } from "../lib/trade-orchestration";
import {
  applySettingsPatch,
  formatSettingsHelp,
  formatUserSettings,
  parseSettingsCommand,
  shouldRequestLiveExecution,
} from "../lib/telegram-settings";
import {
  disableTradingForTelegram,
  getRealizedPnlToday,
  getUserSettingsForTelegram,
  saveUserSettingsForTelegram,
} from "../lib/trade-persistence";
import { getActiveOpenPositionCount } from "../lib/active-positions";
import {
  formatHistoryMessage,
  formatPositionsMessage,
  listActivePositionsForDisplay,
  listHistoryForDisplay,
} from "../lib/position-display";
import { formatTradeExecutionMessage } from "../lib/telegram-trade-format";
import { startFinalizationLoop } from "./finalization-loop";

const active = new Set<number>();
const lastStart = new Map<number, number>();
const cooldownMs = 30_000;
const tradeActive = new Set<number>();

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
        { reply_markup: link(config, hash) },
      );
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
      status: "submitted",
      error_message:
        "Confirmation is still pending or the RPC became unavailable.",
    }).catch(() => undefined);
    await ctx.reply(
      `❌ Transaction failed.\n\nReason: ${safeError(error)}\nTransaction: ${hash}`,
      { reply_markup: link(config, hash) },
    );
    return false;
  }
}

async function runFunding(
  ctx: Context,
  config: AppConfig,
  userId: string,
  wallet: { address: string; encrypted_private_key: string },
) {
  const transactions = await getOnboardingTransactions(
    config,
    userId,
    wallet.address,
  );

  async function reconcile(type: "INITIAL_STT_SPONSOR" | "TUSDC_FAUCET") {
    for (const transaction of transactions.filter((t) => t.type === type)) {
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
    (t) => t.type === "INITIAL_STT_SPONSOR",
  );
  const confirmedFunding = fundingRecords.find((t) => t.status === "confirmed");
  const pendingFunding = fundingRecords.find(
    (t) =>
      t.transaction_hash &&
      (t.status === "pending" || t.status === "submitted"),
  );
  if (
    !confirmedFunding &&
    parseFloat(refreshed.stt) < parseFloat(config.initialGasSponsorAmount) &&
    pendingFunding?.transaction_hash
  ) {
    await ctx.reply(
      `⏳ Your STT sponsorship is still pending.\n\nTransaction: ${pendingFunding.transaction_hash}`,
      { reply_markup: link(config, pendingFunding.transaction_hash) },
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
        { reply_markup: link(config, funding.hash) },
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
    `✅ Wallet setup is complete.\n\nAddress: ${wallet.address}\nSTT: ${finalBalance.stt}\ntUSDC: ${finalBalance.tusdc}\n\nYou can request tUSDC with /faucet <amount>. Configure risk with /settings, then enable trading when ready.`,
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
  for (const transaction of transactions.filter((i) => i.type === "TUSDC_FAUCET")) {
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
    const inspected = await inspectReceipt(config, transaction.transaction_hash);
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
      await confirm(ctx, config, reservation.transaction_id, faucetTx.hash, async () => {
        const current = await balances(config, wallet.address);
        return `✅ ${amount} tUSDC received.\n\nBalance: ${current.tusdc} tUSDC\nRemaining today: ${reservation.remaining} tUSDC`;
      });
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
        return void (await ctx.reply("You do not have a wallet yet. Use /start first."));
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
  bot.command("trade", async (ctx) => {
    if (!ctx.from) return;
    if (tradeActive.has(ctx.from.id)) {
      await ctx.reply("A trade cycle is already in progress.");
      return;
    }
    tradeActive.add(ctx.from.id);
    try {
      const wallet = await findWallet(config, ctx.from.id);
      if (!wallet) {
        await ctx.reply("You do not have a wallet yet. Use /start first.");
        return;
      }
      const identity = {
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };
      const settings = await getUserSettingsForTelegram(config, identity);
      if (!settings.tradingEnabled) {
        await ctx.reply(
          "Trading is disabled for your account.\n\nEnable it with /settings trading on, or review /settings.",
        );
        return;
      }
      const liveRequested = shouldRequestLiveExecution(settings.executionMode, true);
      const result = await runTelegramTradeCycle({
        config,
        identity,
        liveExecutionRequested: liveRequested,
        stake: settings.defaultStake,
      });
      if (!result.ok) {
        await ctx.reply(
          `❌ Trade cycle did not complete.\n\nCode: ${result.code}\nReason: ${result.reason}`,
        );
        return;
      }
      const exec = result.execution;
      const decisionMeta = result.decision as {
        tradingStart?: string;
        intervalSec?: string | null;
        expiry?: string;
      };
      const tradeMsg = formatTradeExecutionMessage({
        tradeId: result.tradeId,
        symbol: result.intentSymbol,
        direction: String(result.decision.direction ?? "n/a"),
        status: exec.ok ? String(exec.status) : exec.code,
        stake: result.stake,
        limitPrice: result.decision.limitPriceHint,
        transactionHash: exec.ok ? (exec.transactionHash ?? null) : null,
        tradingStart: decisionMeta.tradingStart,
        marketExpiry: result.decision.expiry,
        intervalSec: decisionMeta.intervalSec,
        explorerTxBaseUrl: config.explorerTxBaseUrl,
      });
      if (!exec.ok) {
        const gated = exec.gated
          ? "\n\nLive chain submit is blocked (feature gate). Intent may still be recorded."
          : "";
        await ctx.reply(
          `${tradeMsg}\nMode: ${settings.executionMode}\n\nExecution: ${exec.code}\n${exec.reason}${gated}`,
          { link_preview_options: { is_disabled: true } },
        );
        return;
      }
      await ctx.reply(`${tradeMsg}\nMode: ${settings.executionMode}`, {
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      await ctx.reply(`❌ Trade cycle failed.\n\nReason: ${safeError(error)}`);
    } finally {
      tradeActive.delete(ctx.from.id);
    }
  });
  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "DreamDEX Event Contracts bot",
        "",
        "/start — create/resume wallet and gas funding",
        "/faucet <amount> — request tUSDC (up to 500/day UTC)",
        "/status — wallet, balances, trading state, settings",
        "/settings — view or change risk (e.g. max stake 30)",
        "/trade — strategy → persist intent → gated execution",
        "/positions — active positions only",
        "/history — completed, failed, or cancelled trades",
        "/stop — disable trading (keeps history)",
        "/fund — recover interrupted STT funding",
        "/privatekey — export private key (auto-deletes)",
        "",
        "Paper mode never requests live submit. Use /settings mode paper|testnet.",
        "Chain submits still require ENABLE_LIVE_EXECUTION=true on the server.",
      ].join("\n"),
    ),
  );
  bot.command("positions", async (ctx) => {
    try {
      if (!ctx.from) return;
      const userId = await ensureUser(config, ctx.from);
      const positions = await listActivePositionsForDisplay(config, userId);
      await ctx.reply(formatPositionsMessage(positions, config.explorerTxBaseUrl), {
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      await ctx.reply(`Unable to load positions.\n\nReason: ${safeError(error)}`);
    }
  });
  bot.command("history", async (ctx) => {
    try {
      if (!ctx.from) return;
      const userId = await ensureUser(config, ctx.from);
      const history = await listHistoryForDisplay(config, userId);
      await ctx.reply(formatHistoryMessage(history, config.explorerTxBaseUrl), {
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      await ctx.reply(`Unable to load history.\n\nReason: ${safeError(error)}`);
    }
  });
  bot.command("stop", async (ctx) => {
    try {
      if (!ctx.from) return;
      const settings = await disableTradingForTelegram(config, {
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      });
      await ctx.reply(
        `Trading disabled for your account.\n\nHistory and positions are kept.\nTrading enabled: ${settings.tradingEnabled}\n\nRe-enable with /settings trading on.`,
      );
    } catch (error) {
      await ctx.reply(`Unable to stop trading.\n\nReason: ${safeError(error)}`);
    }
  });
  bot.command("settings", async (ctx) => {
    try {
      if (!ctx.from) return;
      const identity = {
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };
      const raw = typeof ctx.match === "string" ? ctx.match : "";
      const parsed = parseSettingsCommand(raw);
      if (parsed.kind === "help") {
        await ctx.reply(formatSettingsHelp(config.systemLimits));
        return;
      }
      if (parsed.kind === "error") {
        await ctx.reply(`❌ ${parsed.reason}`);
        return;
      }
      const current = await getUserSettingsForTelegram(config, identity);
      if (parsed.kind === "show") {
        const [openCount, pnl] = await Promise.all([
          getActiveOpenPositionCount(config, current.userId),
          getRealizedPnlToday(config, current.userId),
        ]);
        await ctx.reply(
          formatUserSettings({
            settings: current,
            system: config.systemLimits,
            openPositionCount: openCount,
            realizedPnlToday: pnl,
          }),
        );
        return;
      }
      const applied = applySettingsPatch(
        current,
        parsed.patch,
        config.systemLimits,
      );
      if (!applied.ok) {
        await ctx.reply(`❌ ${applied.code}\n${applied.reason}`);
        return;
      }
      const saved = await saveUserSettingsForTelegram(
        config,
        identity,
        applied.settings,
      );
      await ctx.reply(
        `✅ Updated ${parsed.label}\n\n` +
          formatUserSettings({ settings: saved, system: config.systemLimits }),
      );
    } catch (error) {
      await ctx.reply(`Unable to update settings.\n\nReason: ${safeError(error)}`);
    }
  });
  bot.command("status", async (ctx) => {
    try {
      if (!ctx.from) return;
      const wallet = await findWallet(config, ctx.from.id);
      if (!wallet)
        return void (await ctx.reply("You do not have a wallet yet. Use /start to begin."));
      await reconcileFaucetTransactions(config, wallet.user_id, wallet.address);
      const identity = {
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };
      const [current, allowance, settings, openCount, pnl] = await Promise.all([
        balances(config, wallet.address),
        getFaucetAllowance(config, wallet.user_id),
        getUserSettingsForTelegram(config, identity),
        // Same expiry-aware definition as /positions
        getActiveOpenPositionCount(config, wallet.user_id),
        getRealizedPnlToday(config, wallet.user_id),
      ]);
      await ctx.reply(
        [
          "Wallet status: ready",
          "",
          `Address: ${wallet.address}`,
          "Network: Somnia Shannon (50312)",
          `STT: ${current.stt}`,
          `tUSDC: ${current.tusdc}`,
          "",
          `Trading: ${settings.tradingEnabled ? "enabled" : "disabled"}`,
          `Mode: ${settings.executionMode}`,
          `Default stake: ${settings.defaultStake} tUSDC`,
          `Max stake: ${settings.maxTradeStake} tUSDC`,
          `Max daily loss: ${settings.maxDailyLoss} tUSDC`,
          `Max open positions: ${settings.maxOpenPositions}`,
          `Open positions: ${openCount}`,
          `PnL today (UTC): ${pnl} tUSDC`,
          `Live execution env: ${config.enableLiveExecution ? "ON" : "OFF"}`,
          "",
          `Faucet today: ${allowance.consumed} / 500 tUSDC`,
          `Remaining: ${allowance.remaining} tUSDC`,
          "Allowance resets at the next UTC day.",
        ].join("\n"),
      );
    } catch (error) {
      await ctx.reply(`Unable to read live balances.\n\nReason: ${safeError(error)}`);
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
          ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => undefined),
        60_000,
      );
    } catch (error) {
      await ctx.reply(`Unable to retrieve the private key.\n\nReason: ${safeError(error)}`);
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
  const finalization = startFinalizationLoop(bot, config);
  void bot
    .start({
      onStart: (info) =>
        logger.info({ username: info.username }, "Telegram bot polling started"),
    })
    .catch((error) =>
      logger.error({ err: safeError(error) }, "Telegram polling stopped"),
    );
  const originalStop = bot.stop.bind(bot);
  bot.stop = (...args: Parameters<typeof bot.stop>) => {
    finalization.stop();
    return originalStop(...args);
  };
  return bot;
}

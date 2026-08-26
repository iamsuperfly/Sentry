/**
 * User-facing Telegram copy. Maps internal codes to plain language.
 * Server logs / DB may still store machine codes; users never see them here.
 */

export type UserFacingMessage = {
  title: string;
  body: string;
};

/** Trade-cycle failures (orchestration / risk / markets). */
export function formatTradeCycleFailure(input: {
  code: string;
  reason?: string;
}): string {
  const mapped = mapTradeCycleCode(input.code, input.reason);
  return [mapped.title, "", mapped.body].join("\n");
}

function mapTradeCycleCode(
  code: string,
  reason?: string,
): UserFacingMessage {
  switch (code) {
    case "no_enter_decision":
      return {
        title: "⚪ No trade placed",
        body: [
          "No market currently meets the strategy's conditions.",
          "No funds were used.",
        ].join("\n"),
      };
    case "markets_unavailable":
      return {
        title: "⚪ Markets unavailable",
        body: "Could not load live markets right now. Try again in a moment.",
      };
    case "trading_disabled":
      return {
        title: "⚪ Trading is off",
        body: "Enable trading with /settings trading on when you are ready.",
      };
    case "unauthenticated":
      return {
        title: "⚪ Not linked",
        body: "Start the bot with /start so we can link your Telegram account.",
      };
    case "duplicate_intent":
      return {
        title: "⚪ Trade already open",
        body: "You already have an open order for this market. Check /positions.",
      };
    case "user_max_open_positions":
    case "max_open_positions":
      return {
        title: "⚪ Position limit reached",
        body: "You are at your maximum number of active trades. Close or wait for one to finish, or raise the limit with /settings max positions.",
      };
    case "max_daily_loss":
    case "user_max_daily_loss":
      return {
        title: "⚪ Daily loss limit reached",
        body: "Further trades are paused for today. Adjust with /settings max daily loss if needed.",
      };
    case "daily_profit_target":
      return {
        title: "⚪ Daily profit target hit",
        body: "Trading pauses after the daily profit target. Change it with /settings profit target.",
      };
    case "default_above_user_max":
    case "stake_above_max":
    case "stake_above_system":
    case "max_trade_stake":
      return {
        title: "⚪ Stake too high",
        body: "That stake is above your max trade size. Lower the stake or raise /settings max stake.",
      };
    case "insufficient_collateral":
    case "insufficient_balance":
      return {
        title: "⚪ Not enough tUSDC",
        body: "Top up with /faucet or reduce your stake.",
      };
    case "stale_intent_cleanup_failed":
    case "persist_failed":
    case "missing_trade_id":
      return {
        title: "❌ Could not record the trade",
        body: "Nothing was submitted on-chain. Please try again shortly.",
      };
    case "live_execution_disabled":
    case "live_not_requested":
      return {
        title: "⚪ Live trading is off",
        body: [
          "Your trade was recorded but not sent to the network.",
          "Paper mode never submits on-chain. Testnet mode still needs live execution enabled on the server.",
        ].join("\n"),
      };
    case "wallet_not_owned":
      return {
        title: "⚪ Wallet not found",
        body: "Create a wallet with /start first.",
      };
    default: {
      const hint =
        reason &&
        !/stage\s*\d|_[a-z]+_|intent|persist|orchestrat|supabase|executionMode/i.test(
          reason,
        )
          ? reason.slice(0, 180)
          : "Please try again or check /status.";
      return {
        title: "❌ Trade could not be completed",
        body: hint,
      };
    }
  }
}

/** Execution-path follow-up when submit is gated or fails after intent. */
export function formatExecutionFollowUp(input: {
  ok: boolean;
  code?: string;
  reason?: string;
  gated?: boolean;
  status?: string;
  executionMode: string;
}): string {
  const modeLabel =
    input.executionMode === "paper" ? "paper (no on-chain orders)" : "testnet";
  if (input.ok) {
    return `Mode: ${modeLabel}`;
  }
  const code = input.code ?? "execution_failed";
  if (code === "live_execution_disabled" || code === "live_not_requested" || input.gated) {
    return [
      `Mode: ${modeLabel}`,
      "",
      "This order was not sent to the blockchain.",
      input.executionMode === "paper"
        ? "Paper mode only simulates risk checks and records."
        : "Live submission is currently disabled on the server.",
    ].join("\n");
  }
  const mapped = mapTradeCycleCode(code, input.reason);
  return [`Mode: ${modeLabel}`, "", mapped.body].join("\n");
}

/** Settings validation failures — strip machine codes from user text. */
export function formatSettingsError(code: string, reason: string): string {
  const friendly: Record<string, string> = {
    max_trade_stake: "That max stake is above the system limit.",
    max_daily_loss: "That daily loss limit is above the system ceiling.",
    max_open_positions: "That position count is above the system ceiling.",
    default_stake: "Default stake must stay within your max stake and system limits.",
    default_above_user_max: "Default stake cannot exceed your max stake.",
    execution_mode: "Mode must be paper or testnet.",
  };
  const line = friendly[code] ?? sanitizeReason(reason);
  return `❌ ${line}`;
}

function sanitizeReason(reason: string): string {
  return reason
    .replace(/\b(Stage\s*\d+|no_enter_decision|live_execution_disabled|executionMode|user_max_\w+|max_daily_loss|max_positions|profit_target)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 200) || "That value is not allowed.";
}

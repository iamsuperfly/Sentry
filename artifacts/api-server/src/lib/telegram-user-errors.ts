/**
 * Map internal trade/risk/SDK failures to Telegram copy.
 * Technical strings stay in logs; this layer never echoes them.
 */

export function extractPnlFromReason(reason: string | null | undefined): number | null {
  if (!reason) return null;
  const patterns = [
    /Today's PnL:\s*([+-]?\d+(?:\.\d+)?)/i,
    /\bpnl\s*=\s*([+-]?\d+(?:\.\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = reason.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function looksLikeIocNoFill(code: string, reason?: string | null): boolean {
  const blob = `${code}\n${reason ?? ""}`;
  return /immediate\s*or\s*cancel\s*no\s*fill/i.test(blob) || /immediateorcancelnofill/i.test(blob);
}

export function looksLikeBookMiss(code: string, reason?: string | null): boolean {
  const blob = `${code}\n${reason ?? ""}`;
  return (
    /book_stale/i.test(blob) ||
    /no_usable_ask/i.test(blob) ||
    /insufficient_liquidity/i.test(blob) ||
    /intended limit/i.test(blob) ||
    /live (yes|no) ask/i.test(blob) ||
    /ask size .+ below contracts/i.test(blob) ||
    /no live .+ ask/i.test(blob)
  );
}

export function looksLikeAllowanceOrRpc(code: string, reason?: string | null): boolean {
  const blob = `${code}\n${reason ?? ""}`.toLowerCase();
  return (
    /allowance/.test(blob) ||
    /\brpc\b/.test(blob) ||
    /chain_read_failed/.test(blob) ||
    /readcontract/.test(blob) ||
    /json-rpc/.test(blob) ||
    /econnreset/.test(blob) ||
    /fetch failed/.test(blob)
  );
}

function signedPnl(n: number): string {
  return `${n > 0 ? "+" : ""}${n}`;
}

export function isEarlyExitNote(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return (
    /early-loss/i.test(raw) ||
    /early-exit/i.test(raw) ||
    /elapsed \d+s/i.test(raw) ||
    /sellTx=/i.test(raw) ||
    /closed early/i.test(raw)
  );
}

const NOTHING_TAKEN = "Nothing was taken at this price. No funds were used.";

export function sanitizeTechnicalErrorNote(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (isEarlyExitNote(raw)) {
    return "Closed early to limit the loss.";
  }
  if (looksLikeIocNoFill("", raw) || looksLikeBookMiss("", raw)) {
    return NOTHING_TAKEN;
  }
  if (looksLikeAllowanceOrRpc("", raw)) {
    return "Network issue. Try again shortly.";
  }
  if (/enable_live_execution/i.test(raw)) {
    return "Live trading is not enabled on the server.";
  }
  if (/[A-Z][A-Za-z]+(?:NoFill|Reverted|Unauthorized|Error)\(/.test(raw)) {
    return NOTHING_TAKEN;
  }
  if (/revert selector|execution reverted/i.test(raw)) {
    return "The order did not complete.";
  }
  if (/0x[0-9a-f]{8}/i.test(raw) && !/sellTx=/i.test(raw)) {
    return "The order did not complete.";
  }
  if (/selected:\s*\d+/i.test(raw) || /^mode:\s*/i.test(raw)) {
    return null;
  }
  return raw.slice(0, 180);
}

export function formatUserFacingTradeFailure(input: {
  code: string;
  reason?: string | null;
  realizedPnlToday?: number | null;
}): string {
  const rawCode = input.code || "";
  const code = rawCode.toLowerCase();
  const reason = input.reason ?? "";
  const pnl =
    input.realizedPnlToday !== undefined && input.realizedPnlToday !== null
      ? input.realizedPnlToday
      : extractPnlFromReason(reason);
  const pnlLine =
    pnl !== null && Number.isFinite(pnl) ? `Today's PnL: ${signedPnl(pnl)} tUSDC` : null;

  if (looksLikeIocNoFill(rawCode, reason) || looksLikeBookMiss(rawCode, reason)) {
    return ["⚪ Not filled", "", NOTHING_TAKEN].join("\n");
  }

  if (
    code === "ai_not_configured" ||
    code === "ai_http_error" ||
    code === "ai_timeout" ||
    code === "ai_network_error" ||
    code === "ai_invalid_response" ||
    code === "ai_empty_response" ||
    code === "ai_invalid_json" ||
    code === "ai_schema_mismatch" ||
    /groq/i.test(reason)
  ) {
    return ["⚪ Signal service unavailable", "", "No trade sent."].join("\n");
  }

  if (
    looksLikeAllowanceOrRpc(rawCode, reason) ||
    code === "chain_read_failed" ||
    code === "broadcast_uncertain"
  ) {
    return [
      "⚪ Network or allowance issue",
      "",
      "Check status and try again shortly.",
      "No funds were used unless a transaction already confirmed.",
    ].join("\n");
  }

  switch (code) {
    case "no_enter_decision":
      return ["⚪ No trade placed", "", "No market currently meets the conditions.", "No funds were used."].join("\n");
    case "trading_disabled":
      return ["⚪ Trading is turned off", "", "Use Settings if you need to review limits."].join("\n");
    case "markets_unavailable":
      return ["⚪ Markets unavailable", "", "Could not load market data right now. Try again shortly.", "No funds were used."].join("\n");
    case "live_execution_disabled":
    case "live_not_requested":
      return ["⚪ Order not submitted on-chain", "", "Live trading is not enabled on the server."].join("\n");
    case "stake_exceeds_user_max":
    case "stake_above_system_max":
    case "stake_below_system_min":
    case "stake_above_user_max":
    case "stake_below_min":
      return ["⚪ Stake not allowed", "", "The requested stake is outside your limits.", "No funds were used."].join("\n");
    case "user_max_open_positions":
    case "system_max_open_positions":
      return ["⚪ Position limit reached", "", "You already have the maximum number of open trades.", "No funds were used."].join("\n");
    case "max_daily_loss":
    case "daily_loss_limit":
    case "user_daily_loss_stop":
    case "system_daily_loss_stop":
      return [
        "⚪ Daily loss limit reached",
        "",
        pnlLine ?? "No new trades until the next UTC day.",
        "Resets at the next UTC midnight.",
        "No funds were used.",
      ].filter(Boolean).join("\n");
    case "profit_target_reached":
    case "daily_profit_target":
    case "daily_profit_target_reached":
      return [
        "⚪ Daily profit target reached",
        "",
        pnlLine ?? "New trades are paused until the next UTC day.",
        "Resets at the next UTC midnight.",
        "No funds were used.",
      ].filter(Boolean).join("\n");
    case "insufficient_collateral":
    case "insufficient_balance":
    case "insufficient_tusdc":
      return ["⚪ Insufficient tUSDC", "", "Add funds from the faucet or check Wallet.", "No trade was placed."].join("\n");
    case "unauthenticated":
      return ["⚪ Wallet not ready", "", "Tap Start first to create your wallet."].join("\n");
    case "persist_failed":
    case "missing_trade_id":
    case "stale_intent_cleanup_failed":
      return ["⚪ Could not record the trade", "", "Please try again in a moment. No on-chain order was sent."].join("\n");
    case "submission_failed":
    case "submission_error":
      return ["⚪ Order did not complete", "", NOTHING_TAKEN].join("\n");
    default:
      return ["⚪ No trade placed", "", "The trade was not completed.", "No funds were used unless a transaction already confirmed."].join("\n");
  }
}

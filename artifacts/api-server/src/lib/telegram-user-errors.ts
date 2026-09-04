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
    /sellTx=/i.test(raw)
  );
}

export function sanitizeTechnicalErrorNote(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (isEarlyExitNote(raw)) {
    return "Closed early to limit the loss.";
  }
  if (looksLikeIocNoFill("", raw)) {
    return "This order did not fill. Nothing was taken.";
  }
  if (looksLikeAllowanceOrRpc("", raw)) {
    return "Network issue. Try again shortly.";
  }
  if (/enable_live_execution/i.test(raw)) {
    return "Live trading is not enabled on the server.";
  }
  if (/[A-Z][A-Za-z]+(?:NoFill|Reverted|Unauthorized|Error)\(/.test(raw)) {
    return "The order did not complete.";
  }
  if (/revert selector|execution reverted/i.test(raw)) {
    return "The order did not complete.";
  }
  if (/0x[0-9a-f]{8}/i.test(raw) && !/sellTx=/i.test(raw)) {
    return "The order did not complete.";
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

  if (looksLikeIocNoFill(rawCode, reason)) {
    return [
      "\u26aa Not filled",
      "",
      "This order did not fill. Nothing was taken.",
    ].join("\n");
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
    return [
      "\u26aa Signal service unavailable",
      "",
      "No trade sent.",
    ].join("\n");
  }

  if (
    looksLikeAllowanceOrRpc(rawCode, reason) ||
    code === "chain_read_failed" ||
    code === "broadcast_uncertain"
  ) {
    return [
      "\u26aa Network or allowance issue",
      "",
      "Check /status and try again shortly.",
      "No funds were used unless a transaction already confirmed.",
    ].join("\n");
  }

  switch (code) {
    case "no_enter_decision":
      return ["\u26aa No trade placed", "", "No market currently meets the strategy's conditions.", "No funds were used."].join("\n");
    case "trading_disabled":
      return ["\u26aa Trading is turned off", "", "Enable it with /settings trading on, or review /settings."].join("\n");
    case "markets_unavailable":
      return ["\u26aa Markets unavailable", "", "Could not load market data right now. Try again shortly.", "No funds were used."].join("\n");
    case "live_execution_disabled":
    case "live_not_requested":
      return ["\u26aa Order not submitted on-chain", "", "Live trading is not enabled on the server.", "Your trade intent may still be recorded."].join("\n");
    case "stake_exceeds_user_max":
    case "stake_above_system_max":
    case "stake_below_system_min":
    case "stake_above_user_max":
    case "stake_below_min":
      return ["\u26aa Stake not allowed", "", "The requested stake is outside your limits. Check /settings.", "No funds were used."].join("\n");
    case "user_max_open_positions":
    case "system_max_open_positions":
      return ["\u26aa Position limit reached", "", "You already have the maximum number of open trades.", "Close or wait for positions to finish, or raise the limit in /settings.", "No funds were used."].join("\n");
    case "max_daily_loss":
    case "daily_loss_limit":
    case "user_daily_loss_stop":
    case "system_daily_loss_stop":
      return [
        "\u26aa Daily loss limit reached",
        "",
        pnlLine ?? "No new trades until the next UTC day.",
        "Resets at the next UTC midnight.",
        "No funds were used.",
      ].filter(Boolean).join("\n");
    case "profit_target_reached":
    case "daily_profit_target":
    case "daily_profit_target_reached":
      return [
        "\u26aa Daily profit target reached",
        "",
        pnlLine ?? "New trades are paused until the next UTC day.",
        "Resets at the next UTC midnight.",
        "No funds were used.",
      ].filter(Boolean).join("\n");
    case "insufficient_collateral":
    case "insufficient_balance":
    case "insufficient_tusdc":
      return ["\u26aa Insufficient tUSDC", "", "Add funds with /faucet or check /status.", "No trade was placed."].join("\n");
    case "unauthenticated":
      return ["\u26aa Wallet not ready", "", "Use /start first to create your wallet."].join("\n");
    case "persist_failed":
    case "missing_trade_id":
    case "stale_intent_cleanup_failed":
      return ["\u26aa Could not record the trade", "", "Please try again in a moment. No on-chain order was sent."].join("\n");
    case "submission_failed":
    case "submission_error":
      return [
        "\u26aa Order did not complete",
        "",
        "Nothing was taken at this price, or the network rejected the send.",
        "No funds were used unless a transaction already confirmed.",
      ].join("\n");
    default:
      return ["\u26aa No trade placed", "", "The trade was not completed.", "No funds were used unless a transaction already confirmed."].join("\n");
  }
}

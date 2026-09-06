import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatUserFacingTradeFailure,
  sanitizeTechnicalErrorNote,
} from "./telegram-user-errors.ts";

describe("human trade errors", () => {
  it("maps IOC no-fill from code or SDK reason", () => {
    const fromReason = formatUserFacingTradeFailure({
      code: "submission_failed",
      reason: "ImmediateOrCancelNoFill()",
    });
    assert.match(fromReason, /Nothing was taken at this price/);
    assert.doesNotMatch(fromReason, /ImmediateOrCancelNoFill/);

    const fromCode = formatUserFacingTradeFailure({
      code: "ImmediateOrCancelNoFill",
    });
    assert.match(fromCode, /Nothing was taken/);
  });

  it("hides live ask vs intended limit diagnostics", () => {
    const text = formatUserFacingTradeFailure({
      code: "book_stale",
      reason: "Live NO ask 0.607 is above intended limit 0.599",
    });
    assert.match(text, /Nothing was taken at this price/);
    assert.doesNotMatch(text, /0\.607/);
    assert.doesNotMatch(text, /intended limit/);
    assert.equal(
      sanitizeTechnicalErrorNote("Live NO ask 0.607 is above intended limit 0.599"),
      "Nothing was taken at this price. No funds were used.",
    );
  });

  it("maps real risk halt codes and includes parsed PnL", () => {
    const loss = formatUserFacingTradeFailure({
      code: "user_daily_loss_stop",
      reason: "Daily loss stop reached (pnl=-42.5, limit=70).",
    });
    assert.match(loss, /Daily loss limit reached/);
    assert.match(loss, /Today's PnL: -42\.5/);
    assert.doesNotMatch(loss, /user_daily_loss_stop/);

    const system = formatUserFacingTradeFailure({
      code: "system_daily_loss_stop",
      realizedPnlToday: -300,
    });
    assert.match(system, /-300/);

    const target = formatUserFacingTradeFailure({
      code: "daily_profit_target_reached",
      reason: "Daily profit target 40 reached (pnl=41).",
    });
    assert.match(target, /Daily profit target reached/);
    assert.match(target, /\+41/);
  });

  it("maps collateral, AI, and RPC failures without leaking internals", () => {
    const cash = formatUserFacingTradeFailure({
      code: "insufficient_collateral",
      reason: "tUSDC balance 2 is below stake 30.",
    });
    assert.match(cash, /Insufficient tUSDC/);
    assert.doesNotMatch(cash, /below stake/);

    const ai = formatUserFacingTradeFailure({
      code: "ai_http_error",
      reason: "Groq HTTP 503: high demand",
    });
    assert.match(ai, /Signal service unavailable/);
    assert.doesNotMatch(ai, /Groq/);
    assert.doesNotMatch(ai, /503/);

    const rpc = formatUserFacingTradeFailure({
      code: "chain_read_failed",
      reason: "rpc readContract balanceOf failed",
    });
    assert.match(rpc, /Network or allowance/);
    assert.doesNotMatch(rpc, /readContract/);
  });

  it("sanitizes SDK notes", () => {
    const note = sanitizeTechnicalErrorNote("ImmediateOrCancelNoFill()");
    assert.match(note ?? "", /Nothing was taken/);
    assert.doesNotMatch(note ?? "", /ImmediateOrCancelNoFill/);
  });
});

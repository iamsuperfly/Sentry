import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatExecutionFollowUp,
  formatSettingsError,
  formatTradeCycleFailure,
} from "./telegram-user-messages.ts";

describe("formatTradeCycleFailure", () => {
  it("maps no_enter_decision without exposing codes or stage names", () => {
    const text = formatTradeCycleFailure({
      code: "no_enter_decision",
      reason: "Stage 2 produced no enter decision for the current markets.",
    });
    assert.match(text, /No trade placed/i);
    assert.match(text, /No funds were used/i);
    assert.doesNotMatch(text, /no_enter_decision/);
    assert.doesNotMatch(text, /Stage\s*2/i);
    assert.doesNotMatch(text, /Code:/);
  });

  it("maps position and loss limits in plain language", () => {
    const pos = formatTradeCycleFailure({ code: "user_max_open_positions" });
    assert.match(pos, /Position limit/i);
    assert.doesNotMatch(pos, /user_max_open_positions/);

    const loss = formatTradeCycleFailure({ code: "max_daily_loss" });
    assert.match(loss, /Daily loss/i);
    assert.doesNotMatch(loss, /max_daily_loss/);
  });

  it("never echoes unknown internal codes", () => {
    const text = formatTradeCycleFailure({
      code: "weird_internal_xyz",
      reason: "Stage 6 reconciliation failed with persist_failed",
    });
    assert.doesNotMatch(text, /weird_internal_xyz/);
    assert.doesNotMatch(text, /Stage\s*6/i);
    assert.doesNotMatch(text, /persist_failed/);
  });
});

describe("formatExecutionFollowUp", () => {
  it("explains gated live submit without feature-gate jargon", () => {
    const text = formatExecutionFollowUp({
      ok: false,
      gated: true,
      code: "live_execution_disabled",
      reason: "ENABLE_LIVE_EXECUTION is false.",
      executionMode: "testnet",
    });
    assert.match(text, /not sent to the blockchain/i);
    assert.doesNotMatch(text, /live_execution_disabled/);
    assert.doesNotMatch(text, /feature gate/i);
    assert.doesNotMatch(text, /Intent/);
  });

  it("labels paper mode clearly on success", () => {
    const text = formatExecutionFollowUp({
      ok: true,
      executionMode: "paper",
    });
    assert.match(text, /paper/i);
  });
});

describe("formatSettingsError", () => {
  it("does not surface raw codes as the primary line", () => {
    const text = formatSettingsError(
      "default_above_user_max",
      "default stake exceeds max_trade_stake",
    );
    assert.match(text, /^❌/);
    assert.doesNotMatch(text, /default_above_user_max/);
  });
});

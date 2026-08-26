import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SYSTEM_LIMITS } from "./system-limits.ts";
import { DEFAULT_USER_PREFERENCES } from "./risk.ts";
import {
  applySettingsPatch,
  formatSettingsHelp,
  parseSettingsCommand,
  shouldRequestLiveExecution,
} from "./telegram-settings.ts";

describe("parseSettingsCommand", () => {
  it("shows settings when empty", () => {
    assert.equal(parseSettingsCommand("").kind, "show");
    assert.equal(parseSettingsCommand(undefined).kind, "show");
  });

  it("parses stake and max stake (natural + underscore)", () => {
    const stake = parseSettingsCommand("stake 5");
    assert.equal(stake.kind, "patch");
    if (stake.kind === "patch") assert.equal(stake.patch.defaultStake, 5);

    const maxNatural = parseSettingsCommand("max stake 25");
    assert.equal(maxNatural.kind, "patch");
    if (maxNatural.kind === "patch")
      assert.equal(maxNatural.patch.maxTradeStake, 25);

    const max = parseSettingsCommand("max_stake 25");
    assert.equal(max.kind, "patch");
    if (max.kind === "patch") assert.equal(max.patch.maxTradeStake, 25);
  });

  it("parses max daily loss and max positions with spaces", () => {
    const loss = parseSettingsCommand("max daily loss 70");
    assert.equal(loss.kind, "patch");
    if (loss.kind === "patch") assert.equal(loss.patch.maxDailyLoss, 70);

    const positions = parseSettingsCommand("max positions 5");
    assert.equal(positions.kind, "patch");
    if (positions.kind === "patch")
      assert.equal(positions.patch.maxOpenPositions, 5);
  });

  it("parses profit target off", () => {
    const p = parseSettingsCommand("profit target off");
    assert.equal(p.kind, "patch");
    if (p.kind === "patch") assert.equal(p.patch.dailyProfitTarget, null);

    const legacy = parseSettingsCommand("profit_target off");
    assert.equal(legacy.kind, "patch");
    if (legacy.kind === "patch") assert.equal(legacy.patch.dailyProfitTarget, null);
  });

  it("parses trading and mode", () => {
    const on = parseSettingsCommand("trading on");
    assert.equal(on.kind, "patch");
    if (on.kind === "patch") assert.equal(on.patch.tradingEnabled, true);

    const mode = parseSettingsCommand("mode paper");
    assert.equal(mode.kind, "patch");
    if (mode.kind === "patch") assert.equal(mode.patch.executionMode, "paper");
  });

  it("returns help", () => {
    assert.equal(parseSettingsCommand("help").kind, "help");
    assert.equal(parseSettingsCommand("?").kind, "help");
  });

  it("rejects unknown field", () => {
    const r = parseSettingsCommand("foo 1");
    assert.equal(r.kind, "error");
  });
});

describe("applySettingsPatch", () => {
  it("accepts a valid max stake patch", () => {
    const result = applySettingsPatch(
      DEFAULT_USER_PREFERENCES,
      { maxTradeStake: 25 },
      DEFAULT_SYSTEM_LIMITS,
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.settings.maxTradeStake, 25);
  });

  it("rejects stake above system max", () => {
    const result = applySettingsPatch(
      DEFAULT_USER_PREFERENCES,
      { maxTradeStake: 99999 },
      DEFAULT_SYSTEM_LIMITS,
    );
    assert.equal(result.ok, false);
  });

  it("rejects default stake above user max stake", () => {
    const result = applySettingsPatch(
      DEFAULT_USER_PREFERENCES,
      { defaultStake: 50, maxTradeStake: 10 },
      DEFAULT_SYSTEM_LIMITS,
    );
    assert.equal(result.ok, false);
  });
});

describe("shouldRequestLiveExecution", () => {
  it("paper mode never requests live", () => {
    assert.equal(shouldRequestLiveExecution("paper", true), false);
    assert.equal(shouldRequestLiveExecution("paper", false), false);
  });

  it("testnet mode follows user request", () => {
    assert.equal(shouldRequestLiveExecution("testnet", true), true);
    assert.equal(shouldRequestLiveExecution("testnet", false), false);
  });
});

describe("formatSettingsHelp", () => {
  it("uses natural language only", () => {
    const help = formatSettingsHelp(DEFAULT_SYSTEM_LIMITS);
    assert.match(help, /max stake/);
    assert.match(help, /max daily loss/);
    assert.doesNotMatch(help, /underscore/i);
    assert.doesNotMatch(help, /max_stake/);
    assert.doesNotMatch(help, /max_daily_loss/);
  });
});

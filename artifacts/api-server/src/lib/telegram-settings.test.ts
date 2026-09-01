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
  });

  it("parses trading on and rejects paper mode", () => {
    const t = parseSettingsCommand("trading on");
    assert.equal(t.kind, "patch");
    if (t.kind === "patch") assert.equal(t.patch.tradingEnabled, true);

    const m = parseSettingsCommand("mode paper");
    assert.equal(m.kind, "error");
  });

  it("rejects unknown field", () => {
    const e = parseSettingsCommand("foo 1");
    assert.equal(e.kind, "error");
  });
});

describe("applySettingsPatch", () => {
  it("accepts valid values within system ceilings", () => {
    const result = applySettingsPatch(
      DEFAULT_USER_PREFERENCES,
      {
        defaultStake: 10,
        maxTradeStake: 20,
        maxDailyLoss: 50,
        maxOpenPositions: 3,
        tradingEnabled: true,
        executionMode: "testnet",
      },
      DEFAULT_SYSTEM_LIMITS,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.settings.defaultStake, 10);
      assert.equal(result.settings.executionMode, "testnet");
      assert.equal(result.settings.tradingEnabled, true);
    }
  });

  it("rejects stake above system max", () => {
    const result = applySettingsPatch(
      DEFAULT_USER_PREFERENCES,
      { maxTradeStake: 9999 },
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
  it("Shannon testnet follows the live-execution request", () => {
    assert.equal(shouldRequestLiveExecution("testnet", true), true);
    assert.equal(shouldRequestLiveExecution("testnet", false), false);
    assert.equal(shouldRequestLiveExecution("paper", true), true);
  });
});

describe("formatSettingsHelp", () => {
  it("uses natural language and lists current system ceilings", () => {
    const help = formatSettingsHelp(DEFAULT_SYSTEM_LIMITS);
    assert.match(help, /max stake 30/);
    assert.match(help, /max daily loss 70/);
    assert.match(help, /max positions 5/);
    assert.match(help, /System limits/);
    assert.match(help, /max positions 10/);
    assert.match(help, /max daily loss 300/);
    assert.doesNotMatch(help, /paper/i);
    assert.doesNotMatch(help, /timezone/i);
    assert.doesNotMatch(help, /max_stake/);
    assert.doesNotMatch(help, /executionMode/);
  });
});

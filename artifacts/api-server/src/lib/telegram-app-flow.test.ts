import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SYSTEM_LIMITS } from "./system-limits.ts";
import { DEFAULT_USER_PREFERENCES } from "./risk.ts";
import {
  BTN,
  formatDashboard,
  formatOnboardIntro,
  isMainMenuLabel,
  parseNumericInput,
  seedDraft,
  SETUP_COMPLETE_TEXT,
  tryApplyOnboardValue,
  tryApplySetting,
} from "./telegram-app-flow.ts";

describe("parseNumericInput", () => {
  it("accepts integers and decimals", () => {
    assert.deepEqual(parseNumericInput("25"), { ok: true, value: 25 });
    assert.deepEqual(parseNumericInput(" 40.5 "), { ok: true, value: 40.5 });
  });

  it("rejects empty and non-numeric text", () => {
    assert.equal(parseNumericInput("").ok, false);
    assert.equal(parseNumericInput("abc").ok, false);
    assert.equal(parseNumericInput("/trade").ok, false);
  });
});

describe("onboard flow", () => {
  it("walks stake → max → loss → positions → profit", () => {
    let draft = seedDraft();
    const stake = tryApplyOnboardValue(draft, "stake", "25", DEFAULT_SYSTEM_LIMITS);
    assert.equal(stake.ok, true);
    if (!stake.ok) return;
    assert.equal(stake.settings.defaultStake, 25);
    assert.equal(stake.next, "maxStake");
    draft = stake.settings;

    const max = tryApplyOnboardValue(draft, "maxStake", "50", DEFAULT_SYSTEM_LIMITS);
    assert.equal(max.ok, true);
    if (!max.ok) return;
    assert.equal(max.settings.maxTradeStake, 50);
    assert.equal(max.next, "dailyLoss");
    draft = max.settings;

    const loss = tryApplyOnboardValue(draft, "dailyLoss", "299", DEFAULT_SYSTEM_LIMITS);
    assert.equal(loss.ok, true);
    if (!loss.ok) return;
    assert.equal(loss.next, "positions");
    draft = loss.settings;

    const pos = tryApplyOnboardValue(draft, "positions", "8", DEFAULT_SYSTEM_LIMITS);
    assert.equal(pos.ok, true);
    if (!pos.ok) return;
    assert.equal(pos.next, "profitTarget");
    draft = pos.settings;

    const profit = tryApplyOnboardValue(draft, "profitTarget", "200", DEFAULT_SYSTEM_LIMITS);
    assert.equal(profit.ok, true);
    if (!profit.ok) return;
    assert.equal(profit.settings.dailyProfitTarget, 200);
    assert.equal(profit.next, null);
  });

  it("rejects max stake below default stake", () => {
    const afterStake = tryApplyOnboardValue(seedDraft(), "stake", "40", DEFAULT_SYSTEM_LIMITS);
    assert.equal(afterStake.ok, true);
    if (!afterStake.ok) return;
    const bad = tryApplyOnboardValue(afterStake.settings, "maxStake", "20", DEFAULT_SYSTEM_LIMITS);
    assert.equal(bad.ok, false);
  });

  it("rejects values above system caps", () => {
    const bad = tryApplyOnboardValue(
      seedDraft(),
      "stake",
      String(DEFAULT_SYSTEM_LIMITS.maxStake + 1),
      DEFAULT_SYSTEM_LIMITS,
    );
    assert.equal(bad.ok, false);
  });
});

describe("settings patch", () => {
  it("updates one field against current settings", () => {
    const current = {
      ...DEFAULT_USER_PREFERENCES,
      defaultStake: 25,
      maxTradeStake: 50,
      maxDailyLoss: 100,
      maxOpenPositions: 5,
    };
    const next = tryApplySetting(current, "defaultStake", "30", DEFAULT_SYSTEM_LIMITS);
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.equal(next.settings.defaultStake, 30);
  });

  it("rejects default stake above max stake", () => {
    const current = {
      ...DEFAULT_USER_PREFERENCES,
      defaultStake: 10,
      maxTradeStake: 20,
      maxDailyLoss: 50,
      maxOpenPositions: 3,
    };
    const bad = tryApplySetting(current, "defaultStake", "40", DEFAULT_SYSTEM_LIMITS);
    assert.equal(bad.ok, false);
  });
});

describe("copy and buttons", () => {
  it("formats intro from live defaults and system limits", () => {
    const text = formatOnboardIntro(DEFAULT_USER_PREFERENCES, DEFAULT_SYSTEM_LIMITS);
    assert.match(text, /Default stake: 1 tUSDC/);
    assert.match(text, new RegExp(`Max stake: ${DEFAULT_SYSTEM_LIMITS.maxStake}`));
    assert.match(text, /less than 2 minutes/);
  });

  it("formats a compact dashboard", () => {
    const text = formatDashboard({
      tusdc: "120.5",
      openPositions: 2,
      maxOpenPositions: 8,
      dailyPnl: 12.5,
      autonomousEnabled: true,
      autonomousPaused: false,
    });
    assert.match(text, /tUSDC: 120.5/);
    assert.match(text, /Positions: 2 \/ 8/);
    assert.match(text, /Today's PnL: \+12.5/);
    assert.match(text, /Autonomous: on/);
    assert.doesNotMatch(text, /trading enabled/i);
  });

  it("recognizes main menu labels only", () => {
    assert.equal(isMainMenuLabel(BTN.tradeNow), true);
    assert.equal(isMainMenuLabel(`${BTN.autonomous}: ON`), true);
    assert.equal(isMainMenuLabel("25"), false);
    assert.equal(isMainMenuLabel("/trade"), false);
  });

  it("has setup-complete copy pointing at Help → Settings", () => {
    assert.match(SETUP_COMPLETE_TEXT, /Help → Settings/);
  });
});

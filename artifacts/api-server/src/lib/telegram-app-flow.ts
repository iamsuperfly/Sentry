/**
 * Pure Telegram app-UX helpers: parse numbers, apply onboard/settings
 * patches, and format dashboard/settings copy. No I/O.
 */

import type { SystemRiskLimits } from "./system-limits.ts";
import {
  DEFAULT_USER_PREFERENCES,
  type UserRiskPreferences,
  validateUserSettings,
} from "./risk.ts";
import { applySettingsPatch } from "./telegram-settings.ts";

export const BTN = {
  tradeNow: "⚡ TRADE NOW",
  autonomous: "🤖 AUTONOMOUS",
  positions: "POSITIONS",
  performance: "PERFORMANCE",
  wallet: "WALLET",
  help: "HELP",
  getTokens: "GET TEST TOKENS",
  skipFaucet: "SKIP",
  claim: "CLAIM SETTLED",
  settings: "SETTINGS",
  tradingHelp: "TRADING",
  autoHelp: "AUTONOMOUS",
  howItWorks: "HOW IT WORKS",
  history: "HISTORY",
  leaderboard: "LEADERBOARD",
  privateKey: "PRIVATE KEY",
  revealKey: "REVEAL KEY",
  hideKey: "HIDE NOW",
  changeStake: "CHANGE DEFAULT STAKE",
  changeMaxStake: "CHANGE MAX STAKE",
  changeDailyLoss: "CHANGE DAILY LOSS",
  changePositions: "CHANGE MAX POSITIONS",
  changeProfit: "CHANGE PROFIT TARGET",
  startAuto: "START AUTONOMOUS",
  pauseAuto: "PAUSE AUTONOMOUS",
  backMenu: "MAIN MENU",
  backHelp: "BACK TO HELP",
  backSettings: "BACK TO SETTINGS",
} as const;

const MAIN_MENU_LABELS = new Set<string>([
  BTN.tradeNow,
  BTN.autonomous,
  BTN.positions,
  BTN.performance,
  BTN.wallet,
  BTN.help,
]);

export function isMainMenuLabel(text: string): boolean {
  const value = text.trim();
  if (MAIN_MENU_LABELS.has(value)) return true;
  return value.startsWith(`${BTN.autonomous}:`);
}

export type OnboardStep =
  | "stake"
  | "maxStake"
  | "dailyLoss"
  | "positions"
  | "profitTarget";

export const ONBOARD_ORDER: OnboardStep[] = [
  "stake",
  "maxStake",
  "dailyLoss",
  "positions",
  "profitTarget",
];

export type SettingField =
  | "defaultStake"
  | "maxTradeStake"
  | "maxDailyLoss"
  | "maxOpenPositions"
  | "dailyProfitTarget";

export type ConversationState =
  | { kind: "idle" }
  | { kind: "onboard_faucet"; returning: boolean }
  | { kind: "onboard"; step: OnboardStep; draft: UserRiskPreferences }
  | { kind: "setting"; field: SettingField }
  | { kind: "faucet_amount" };

export const DEFAULT_FAUCET_AMOUNT = "100";

export function parseNumericInput(raw: string):
  | { ok: true; value: number }
  | { ok: false; reason: string } {
  const text = raw.trim().replace(/,/g, "");
  if (!text) return { ok: false, reason: "Enter a number." };
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    return { ok: false, reason: "That is not a number. Enter a number." };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: "That is not a number. Enter a number." };
  }
  return { ok: true, value };
}

export function rangeHint(
  field: OnboardStep | SettingField,
  system: SystemRiskLimits,
): string {
  switch (field) {
    case "stake":
    case "defaultStake":
    case "maxStake":
    case "maxTradeStake":
      return `Enter a number between ${system.minStake} and ${system.maxStake}.`;
    case "dailyLoss":
    case "maxDailyLoss":
      return `Enter a number between ${system.minStake} and ${system.maxDailyLoss}.`;
    case "positions":
    case "maxOpenPositions":
      return `Enter a whole number between 1 and ${system.maxOpenPositions}.`;
    case "profitTarget":
    case "dailyProfitTarget":
      return "Enter a positive number, or 0 to turn the target off.";
    default:
      return "Enter a number.";
  }
}

export function stepLabel(step: OnboardStep): string {
  switch (step) {
    case "stake":
      return "Default stake";
    case "maxStake":
      return "Max stake";
    case "dailyLoss":
      return "Max daily loss";
    case "positions":
      return "Max open positions";
    case "profitTarget":
      return "Daily profit target";
  }
}

export function nextOnboardStep(step: OnboardStep): OnboardStep | null {
  const i = ONBOARD_ORDER.indexOf(step);
  return i >= 0 && i < ONBOARD_ORDER.length - 1 ? ONBOARD_ORDER[i + 1]! : null;
}

export function formatCurrentSettingsBlock(settings: UserRiskPreferences): string {
  const profit =
    settings.dailyProfitTarget === null || settings.dailyProfitTarget === undefined
      ? "off"
      : `${settings.dailyProfitTarget} tUSDC`;
  return [
    `• Default stake: ${settings.defaultStake} tUSDC`,
    `• Max stake: ${settings.maxTradeStake} tUSDC`,
    `• Max daily loss: ${settings.maxDailyLoss} tUSDC`,
    `• Max open positions: ${settings.maxOpenPositions}`,
    `• Daily profit target: ${profit}`,
  ].join("\n");
}

export function formatSystemLimitsBlock(system: SystemRiskLimits): string {
  return [
    `• Min stake: ${system.minStake} tUSDC`,
    `• Max stake: ${system.maxStake} tUSDC`,
    `• Max daily loss: ${system.maxDailyLoss} tUSDC`,
    `• Max open positions: ${system.maxOpenPositions}`,
  ].join("\n");
}

export function formatOnboardIntro(
  settings: UserRiskPreferences,
  system: SystemRiskLimits,
): string {
  return [
    "Let's set your trading defaults.",
    "",
    "Current settings:",
    formatCurrentSettingsBlock(settings),
    "",
    "System limits:",
    formatSystemLimitsBlock(system),
    "",
    "This is going to take less than 2 minutes.",
    "We'll go through them one at a time.",
    "",
    "Enter your default stake:",
  ].join("\n");
}

export function formatSettingsSnapshot(settings: UserRiskPreferences): string {
  return ["Your settings", "", formatCurrentSettingsBlock(settings)].join("\n");
}

export function formatDashboard(input: {
  tusdc: string;
  openPositions: number;
  maxOpenPositions: number;
  dailyPnl: number;
  autonomousEnabled: boolean;
  autonomousPaused: boolean;
}): string {
  const pnl = `${input.dailyPnl > 0 ? "+" : ""}${input.dailyPnl}`;
  const auto = input.autonomousEnabled
    ? input.autonomousPaused
      ? "paused for today"
      : "on"
    : "off";
  return [
    "DreamEventBot",
    "",
    `tUSDC: ${input.tusdc}`,
    `Positions: ${input.openPositions} / ${input.maxOpenPositions}`,
    `Today's PnL: ${pnl} tUSDC`,
    `Autonomous: ${auto}`,
  ].join("\n");
}

function applyOnboardField(
  draft: UserRiskPreferences,
  step: OnboardStep,
  value: number,
  system: SystemRiskLimits,
): { ok: true; settings: UserRiskPreferences } | { ok: false; reason: string } {
  if (step === "profitTarget") {
    const dailyProfitTarget = value === 0 ? null : value;
    if (dailyProfitTarget !== null && dailyProfitTarget < 0) {
      return { ok: false, reason: rangeHint(step, system) };
    }
    const checked = validateUserSettings({ ...draft, dailyProfitTarget }, system);
    if (!checked.ok) return { ok: false, reason: rangeHint(step, system) };
    return { ok: true, settings: checked.settings };
  }

  if (step === "positions") {
    if (!Number.isInteger(value)) {
      return { ok: false, reason: rangeHint(step, system) };
    }
    const checked = validateUserSettings({ ...draft, maxOpenPositions: value }, system);
    if (!checked.ok) return { ok: false, reason: rangeHint(step, system) };
    return { ok: true, settings: checked.settings };
  }

  if (step === "stake") {
    if (value < system.minStake || value > system.maxStake) {
      return { ok: false, reason: rangeHint(step, system) };
    }
    return {
      ok: true,
      settings: {
        ...draft,
        defaultStake: value,
        maxTradeStake: Math.max(draft.maxTradeStake, value),
      },
    };
  }

  if (step === "maxStake") {
    if (value < draft.defaultStake || value > system.maxStake) {
      return {
        ok: false,
        reason: `Max stake must be between ${draft.defaultStake} and ${system.maxStake}.`,
      };
    }
    const checked = validateUserSettings({ ...draft, maxTradeStake: value }, system);
    if (!checked.ok) return { ok: false, reason: rangeHint(step, system) };
    return { ok: true, settings: checked.settings };
  }

  if (step === "dailyLoss") {
    const checked = validateUserSettings({ ...draft, maxDailyLoss: value }, system);
    if (!checked.ok) return { ok: false, reason: rangeHint(step, system) };
    return { ok: true, settings: checked.settings };
  }

  return { ok: false, reason: "Unknown step." };
}

export function tryApplyOnboardValue(
  draft: UserRiskPreferences,
  step: OnboardStep,
  raw: string,
  system: SystemRiskLimits,
):
  | { ok: true; settings: UserRiskPreferences; next: OnboardStep | null }
  | { ok: false; reason: string } {
  const parsed = parseNumericInput(raw);
  if (!parsed.ok) return parsed;
  const applied = applyOnboardField(draft, step, parsed.value, system);
  if (!applied.ok) return applied;
  return { ok: true, settings: applied.settings, next: nextOnboardStep(step) };
}

export function tryApplySetting(
  current: UserRiskPreferences,
  field: SettingField,
  raw: string,
  system: SystemRiskLimits,
):
  | { ok: true; settings: UserRiskPreferences; label: string }
  | { ok: false; reason: string } {
  const parsed = parseNumericInput(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;

  let patch: Partial<UserRiskPreferences>;
  let label: string;
  switch (field) {
    case "defaultStake":
      patch = { defaultStake: value };
      label = `Default stake set to ${value} tUSDC.`;
      break;
    case "maxTradeStake":
      patch = { maxTradeStake: value };
      label = `Max stake set to ${value} tUSDC.`;
      break;
    case "maxDailyLoss":
      patch = { maxDailyLoss: value };
      label = `Max daily loss set to ${value} tUSDC.`;
      break;
    case "maxOpenPositions":
      if (!Number.isInteger(value)) {
        return { ok: false, reason: rangeHint(field, system) };
      }
      patch = { maxOpenPositions: value };
      label = `Max open positions set to ${value}.`;
      break;
    case "dailyProfitTarget":
      patch = { dailyProfitTarget: value === 0 ? null : value };
      label =
        value === 0
          ? "Daily profit target turned off."
          : `Daily profit target set to ${value} tUSDC.`;
      break;
  }

  const applied = applySettingsPatch(current, patch, system);
  if (!applied.ok) return { ok: false, reason: rangeHint(field, system) };
  return { ok: true, settings: applied.settings, label };
}

export function seedDraft(current?: UserRiskPreferences): UserRiskPreferences {
  return { ...DEFAULT_USER_PREFERENCES, ...current, executionMode: "testnet" };
}

export function formatOnboardConfirm(
  step: OnboardStep,
  settings: UserRiskPreferences,
): string {
  switch (step) {
    case "stake":
      return `Default stake set to ${settings.defaultStake} tUSDC.`;
    case "maxStake":
      return `Max stake set to ${settings.maxTradeStake} tUSDC.`;
    case "dailyLoss":
      return `Max daily loss set to ${settings.maxDailyLoss} tUSDC.`;
    case "positions":
      return `Max open positions set to ${settings.maxOpenPositions}.`;
    case "profitTarget": {
      const t = settings.dailyProfitTarget;
      return t === null || t === undefined
        ? "Daily profit target turned off."
        : `Daily profit target set to ${t} tUSDC.`;
    }
  }
}

export function formatAskStep(step: OnboardStep): string {
  return `Next: ${stepLabel(step)}\n\nEnter a number:`;
}

export const SETUP_COMPLETE_TEXT = [
  "Setup complete.",
  "",
  "Your trading defaults are ready.",
  "You can view or change your settings anytime from Help → Settings.",
].join("\n");

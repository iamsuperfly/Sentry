/**
 * Pure Telegram settings command parsing and formatting.
 * Persistence and system-limit validation live in risk/trade-persistence.
 *
 * User-facing commands prefer natural phrases ("max stake", "max daily loss").
 * Underscore aliases remain accepted for compatibility.
 */

import type { SystemRiskLimits } from "./system-limits.ts";
import {
  DEFAULT_USER_PREFERENCES,
  type ExecutionMode,
  type UserRiskPreferences,
  validateUserSettings,
} from "./risk.ts";

export type ParsedSettingsCommand =
  | { kind: "show" }
  | { kind: "help" }
  | {
      kind: "patch";
      patch: Partial<UserRiskPreferences>;
      label: string;
    }
  | { kind: "error"; reason: string };

function parsePositive(raw: string, label: string): number | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `${label} must be a positive number.` };
  }
  return n;
}

function parseOnOff(raw: string): boolean | { error: string } {
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled"].includes(v)) return true;
  if (["off", "false", "0", "no", "disable", "disabled"].includes(v))
    return false;
  return { error: "Use on or off." };
}

type FieldMatch = {
  field:
    | "stake"
    | "max_stake"
    | "max_daily_loss"
    | "max_positions"
    | "profit_target"
    | "trading"
    | "mode";
  value: string;
};

function matchSettingsField(text: string): FieldMatch | null {
  const lower = text.trim().toLowerCase();
  if (!lower) return null;

  const multi: Array<{ prefix: string; field: FieldMatch["field"] }> = [
    { prefix: "max daily loss", field: "max_daily_loss" },
    { prefix: "max trade stake", field: "max_stake" },
    { prefix: "max stake", field: "max_stake" },
    { prefix: "max open positions", field: "max_positions" },
    { prefix: "max positions", field: "max_positions" },
    { prefix: "daily profit target", field: "profit_target" },
    { prefix: "profit target", field: "profit_target" },
    { prefix: "daily profit", field: "profit_target" },
    { prefix: "default stake", field: "stake" },
    { prefix: "execution mode", field: "mode" },
  ];

  for (const entry of multi) {
    if (lower === entry.prefix || lower.startsWith(entry.prefix + " ")) {
      return {
        field: entry.field,
        value: text.trim().slice(entry.prefix.length).trim(),
      };
    }
  }

  const parts = text.trim().split(/\s+/);
  const field = parts[0]?.toLowerCase();
  if (!field) return null;
  const value = parts.slice(1).join(" ").trim();

  const aliases: Record<string, FieldMatch["field"]> = {
    stake: "stake",
    default_stake: "stake",
    max_stake: "max_stake",
    max_trade_stake: "max_stake",
    max_daily_loss: "max_daily_loss",
    daily_loss: "max_daily_loss",
    max_positions: "max_positions",
    positions: "max_positions",
    profit_target: "profit_target",
    daily_profit: "profit_target",
    trading: "trading",
    enabled: "trading",
    mode: "mode",
    execution_mode: "mode",
  };

  const mapped = aliases[field];
  if (!mapped) return null;
  return { field: mapped, value };
}

export function parseSettingsCommand(
  raw: string | undefined,
): ParsedSettingsCommand {
  const text = (raw ?? "").trim();
  if (!text || text.toLowerCase() === "show") return { kind: "show" };
  if (text.toLowerCase() === "help" || text === "?") return { kind: "help" };

  const matched = matchSettingsField(text);
  if (!matched) {
    const field = text.split(/\s+/)[0] ?? "";
    return {
      kind: "error",
      reason: `Unknown settings field "${field}". Use /settings help.`,
    };
  }

  const { field, value } = matched;

  switch (field) {
    case "stake": {
      if (!value)
        return { kind: "error", reason: "Usage: /settings stake <amount>" };
      const n = parsePositive(value, "stake");
      if (typeof n === "object") return { kind: "error", reason: n.error };
      return {
        kind: "patch",
        patch: { defaultStake: n },
        label: `default stake → ${n} tUSDC`,
      };
    }
    case "max_stake": {
      if (!value)
        return {
          kind: "error",
          reason: "Usage: /settings max stake <amount>",
        };
      const n = parsePositive(value, "max stake");
      if (typeof n === "object") return { kind: "error", reason: n.error };
      return {
        kind: "patch",
        patch: { maxTradeStake: n },
        label: `max trade stake → ${n} tUSDC`,
      };
    }
    case "max_daily_loss": {
      if (!value)
        return {
          kind: "error",
          reason: "Usage: /settings max daily loss <amount>",
        };
      const n = parsePositive(value, "max daily loss");
      if (typeof n === "object") return { kind: "error", reason: n.error };
      return {
        kind: "patch",
        patch: { maxDailyLoss: n },
        label: `max daily loss → ${n} tUSDC`,
      };
    }
    case "max_positions": {
      if (!value)
        return {
          kind: "error",
          reason: "Usage: /settings max positions <count>",
        };
      const n = parsePositive(value, "max positions");
      if (typeof n === "object") return { kind: "error", reason: n.error };
      if (!Number.isInteger(n)) {
        return {
          kind: "error",
          reason: "max positions must be a whole number.",
        };
      }
      return {
        kind: "patch",
        patch: { maxOpenPositions: n },
        label: `max open positions → ${n}`,
      };
    }
    case "profit_target": {
      if (!value)
        return {
          kind: "error",
          reason: "Usage: /settings profit target <amount|off>",
        };
      if (
        ["off", "none", "null", "disable", "0"].includes(value.toLowerCase())
      ) {
        return {
          kind: "patch",
          patch: { dailyProfitTarget: null },
          label: "daily profit target → off",
        };
      }
      const n = parsePositive(value, "profit target");
      if (typeof n === "object") return { kind: "error", reason: n.error };
      return {
        kind: "patch",
        patch: { dailyProfitTarget: n },
        label: `daily profit target → ${n} tUSDC`,
      };
    }
    case "trading": {
      if (!value)
        return { kind: "error", reason: "Usage: /settings trading on|off" };
      const on = parseOnOff(value);
      if (typeof on === "object") return { kind: "error", reason: on.error };
      return {
        kind: "patch",
        patch: { tradingEnabled: on },
        label: `trading → ${on ? "enabled" : "disabled"}`,
      };
    }
    case "mode":
      return {
        kind: "error",
        reason: "Paper mode has been removed. Trading is Shannon testnet only.",
      };
    default:
      return {
        kind: "error",
        reason: `Unknown settings field. Use /settings help.`,
      };
  }
}

export function mergeSettingsPatch(
  current: UserRiskPreferences,
  patch: Partial<UserRiskPreferences>,
): UserRiskPreferences {
  return {
    ...current,
    ...patch,
    dailyProfitTarget:
      patch.dailyProfitTarget === undefined
        ? current.dailyProfitTarget
        : patch.dailyProfitTarget,
    executionMode: "testnet",
  };
}

export function applySettingsPatch(
  current: UserRiskPreferences,
  patch: Partial<UserRiskPreferences>,
  system: SystemRiskLimits,
):
  | { ok: true; settings: UserRiskPreferences }
  | { ok: false; code: string; reason: string } {
  const merged = mergeSettingsPatch(current, patch);
  return validateUserSettings(merged, system);
}

export function formatSettingsHelp(system: SystemRiskLimits): string {
  return [
    "Settings (amounts in tUSDC):",
    "",
    "/settings — show your configuration",
    "/settings stake 10 — default amount used when you run /trade",
    "/settings max stake 30 — hard cap per trade",
    "/settings max daily loss 70 — maximum loss allowed per UTC day",
    "/settings max positions 5 — maximum active trades",
    "/settings profit target 200 — daily profit target (or off)",
    "/settings trading on — enable or disable trading",
    "",
    "Also: /auto on|off, /leaderboard, /claim, /trade",
    "",
    "Default stake is what /trade uses today.",
    "Max stake is the per-trade ceiling (default stake cannot exceed it).",
    "Mode is Shannon testnet only. Live submit still needs ENABLE_LIVE_EXECUTION.",
    "Daily limits reset at UTC midnight.",
    "",
    `System limits: stake ${system.minStake}–${system.maxStake} tUSDC, max positions ${system.maxOpenPositions}, max daily loss ${system.maxDailyLoss} tUSDC.`,
    "Values outside these limits are rejected (not silently changed).",
    "",
    `Defaults for new users: stake ${DEFAULT_USER_PREFERENCES.defaultStake}, max stake ${DEFAULT_USER_PREFERENCES.maxTradeStake}, max daily loss ${DEFAULT_USER_PREFERENCES.maxDailyLoss}, max positions ${DEFAULT_USER_PREFERENCES.maxOpenPositions}, trading off.`,
  ].join("\n");
}

export function formatUserSettings(input: {
  settings: UserRiskPreferences & { userId?: string };
  system: SystemRiskLimits;
  openPositionCount?: number;
  realizedPnlToday?: number;
}): string {
  const s = input.settings;
  const profit =
    s.dailyProfitTarget === null || s.dailyProfitTarget === undefined
      ? "off"
      : `${s.dailyProfitTarget} tUSDC`;
  const lines = [
    "Your trading settings",
    "",
    `Trading: ${s.tradingEnabled ? "enabled" : "disabled"}`,
    "Mode: Shannon testnet",
    `Default stake: ${s.defaultStake} tUSDC (used by /trade)`,
    `Max stake: ${s.maxTradeStake} tUSDC (per-trade ceiling)`,
    `Max daily loss: ${s.maxDailyLoss} tUSDC`,
    `Max open positions: ${s.maxOpenPositions}`,
    `Daily profit target: ${profit}`,
    "",
    `System limits: min stake ${input.system.minStake}, max stake ${input.system.maxStake}, max positions ${input.system.maxOpenPositions}, max daily loss ${input.system.maxDailyLoss}`,
  ];
  if (input.openPositionCount !== undefined) {
    lines.push(`Open positions now: ${input.openPositionCount}`);
  }
  if (input.realizedPnlToday !== undefined) {
    lines.push(`Realized PnL today (UTC): ${input.realizedPnlToday} tUSDC`);
  }
  lines.push("", "Change values with /settings help");
  return lines.join("\n");
}

/** Paper mode is retired. Live submit follows ENABLE_LIVE_EXECUTION + request. */
export function shouldRequestLiveExecution(
  _executionMode: ExecutionMode,
  userRequested: boolean,
): boolean {
  return userRequested === true;
}

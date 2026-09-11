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
import {
  parseAdaptiveStakeBands,
  resolveAdaptiveStakeBands,
  type AdaptiveStakeBand,
} from "./adaptive-stake.ts";

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
    | "mode"
    | "adaptive";
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
    { prefix: "adaptive stake", field: "adaptive" },
    { prefix: "adaptive bands", field: "adaptive" },
    { prefix: "adaptive", field: "adaptive" },
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
    adaptive: "adaptive",
    bands: "adaptive",
  };

  const mapped = aliases[field];
  if (!mapped) return null;
  return { field: mapped, value };
}

function parseAdaptiveSettings(value: string): ParsedSettingsCommand {
  const text = value.trim().toLowerCase();
  if (!text || text === "show") {
    return { kind: "show" };
  }
  if (text === "reset" || text === "default" || text === "defaults") {
    return {
      kind: "patch",
      patch: { adaptiveStakeBands: null },
      label: "adaptive stake bands → system defaults",
    };
  }
  const stripped = text.replace(/^bands\s+/, "");
  const parts = stripped.split(/\s+/).filter(Boolean);
  const bands: AdaptiveStakeBand[] = [];
  for (const part of parts) {
    if (part.includes(":")) {
      const [boundRaw, fracRaw] = part.split(":");
      const bound = Number(boundRaw);
      const frac = parseAdaptiveFraction(fracRaw ?? "");
      if (!Number.isFinite(bound) || bound <= 0 || frac === null) {
        return {
          kind: "error",
          reason:
            "Usage: /settings adaptive 0.55:25 0.65:30 0.75:40 0.85:60 80  (last value is the unbounded fraction; percents or 0-1)",
        };
      }
      bands.push({ maxStrength: bound, fraction: frac });
    } else {
      const frac = parseAdaptiveFraction(part);
      if (frac === null) {
        return {
          kind: "error",
          reason:
            "Usage: /settings adaptive 0.55:25 0.65:30 0.75:40 0.85:60 80",
        };
      }
      bands.push({ maxStrength: null, fraction: frac });
    }
  }
  const parsed = parseAdaptiveStakeBands(bands);
  if (!parsed) {
    return {
      kind: "error",
      reason:
        "Adaptive bands must increase and end with an unbounded fraction. Example: /settings adaptive 0.55:25 0.65:30 0.75:40 0.85:60 80",
    };
  }
  return {
    kind: "patch",
    patch: { adaptiveStakeBands: parsed },
    label: `adaptive stake bands → ${formatAdaptiveBandSummary(parsed)}`,
  };
}

function parseAdaptiveFraction(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1 && n <= 100) return n / 100;
  if (n > 1) return null;
  return n;
}

export function formatAdaptiveBandSummary(
  bands: readonly AdaptiveStakeBand[] | null | undefined,
): string {
  const resolved = resolveAdaptiveStakeBands(bands);
  return resolved
    .map((band) =>
      band.maxStrength === null
        ? `${Math.round(band.fraction * 100)}%`
        : `<${band.maxStrength}→${Math.round(band.fraction * 100)}%`,
    )
    .join(", ");
}

export function formatAdaptiveBandsPrompt(
  bands: Parameters<typeof formatAdaptiveBandSummary>[0],
): string {
  return [
    "Adaptive stake bands",
    "",
    `Current: ${bands ? "custom" : "system defaults"} (${formatAdaptiveBandSummary(bands)})`,
    "",
    "Send new bands, or send reset.",
    "Example: 0.55:25 0.65:30 0.75:40 0.85:60 80",
    "The last number is the unbounded fraction (percent or 0-1).",
    "This only changes the existing band percentages. The sizing formula stays the same.",
  ].join("\n");
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
    case "adaptive":
      return parseAdaptiveSettings(value);
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
    adaptiveStakeBands:
      patch.adaptiveStakeBands === undefined
        ? current.adaptiveStakeBands
        : patch.adaptiveStakeBands,
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
    "Need STT gas? Claim it with @somnia_helper_bot.",
    "Sentry sponsors STT only once, when the wallet is created.",
    "",
    "/settings — show your configuration",
    "/settings stake 10 — default amount used when you run /trade",
    "/settings max stake 30 — autonomous adaptive ceiling (and /trade cap)",
    "/settings max daily loss 70 — maximum loss allowed per UTC day",
    "/settings max positions 5 — maximum active trades",
    "/settings profit target 200 — daily profit target (or off)",
    "/settings trading on — enable or disable trading",
    "/settings adaptive — show adaptive stake bands",
    "/settings adaptive reset — restore system-default adaptive bands",
    "/settings adaptive 0.55:25 0.65:30 0.75:40 0.85:60 80 — custom bands",
    "",
    "Also: /auto on|off, /leaderboard, /claim, /trade",
    "",
    "Default stake is the manual /trade amount.",
    "Max stake is the autonomous adaptive ceiling (default stake cannot exceed it).",
    "Adaptive bands size the autonomous stake from entry price. Unconfigured users keep Sentry defaults.",
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
    `Default stake: ${s.defaultStake} tUSDC (manual /trade)`,
    `Max stake: ${s.maxTradeStake} tUSDC (autonomous adaptive ceiling)`,
    `Max daily loss: ${s.maxDailyLoss} tUSDC`,
    `Max open positions: ${s.maxOpenPositions} (your cap; system cap ${input.system.maxOpenPositions})`,
    `Daily profit target: ${profit}`,
    `Adaptive stake: ${s.adaptiveStakeBands ? "custom" : "system defaults"} (${formatAdaptiveBandSummary(s.adaptiveStakeBands)})`,
    "Trading day: UTC (00:00)",
    "",
    `System limits: min stake ${input.system.minStake}, max stake ${input.system.maxStake}, max positions ${input.system.maxOpenPositions}, max daily loss ${input.system.maxDailyLoss}`,
  ];
  if (input.openPositionCount !== undefined) {
    lines.push(
      `Open positions now: ${input.openPositionCount} / ${s.maxOpenPositions} (system cap ${input.system.maxOpenPositions})`,
    );
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

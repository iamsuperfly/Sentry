import type { AppConfig } from "../config.ts";
import { getSupabaseClient } from "./supabase.ts";
import {
  calendarDateInZone,
  DEFAULT_USER_TIMEZONE,
  normalizeTimezone,
} from "./user-timezone.ts";

export type AutonomousRow = {
  userId: string;
  telegramUserId: number;
  chatId: number | null;
  timezone: string;
  tradingEnabled: boolean;
  autonomousEnabled: boolean;
  autonomousPausedAt: string | null;
  lastAutonomousScanAt: string | null;
  lastAutonomousLocalDate: string | null;
  defaultStake: number;
  executionMode: "paper" | "testnet";
};

export async function listAutonomousCandidates(
  config: AppConfig,
): Promise<AutonomousRow[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("user_settings")
    .select(
      "user_id, timezone, trading_enabled, autonomous_enabled, autonomous_paused_at, last_autonomous_scan_at, last_autonomous_local_date, telegram_chat_id, default_stake_usdso, execution_mode, telegram_users!inner(telegram_user_id)",
    )
    .eq("autonomous_enabled", true);
  if (error) throw new Error("Unable to list autonomous users.");

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const users = r.telegram_users as
      | { telegram_user_id?: number }
      | { telegram_user_id?: number }[]
      | null;
    const profile = Array.isArray(users) ? users[0] : users;
    return {
      userId: String(r.user_id),
      telegramUserId: Number(profile?.telegram_user_id ?? 0),
      chatId: r.telegram_chat_id === null ? null : Number(r.telegram_chat_id),
      timezone: normalizeTimezone(String(r.timezone ?? DEFAULT_USER_TIMEZONE)),
      tradingEnabled: Boolean(r.trading_enabled),
      autonomousEnabled: Boolean(r.autonomous_enabled),
      autonomousPausedAt: (r.autonomous_paused_at as string | null) ?? null,
      lastAutonomousScanAt: (r.last_autonomous_scan_at as string | null) ?? null,
      lastAutonomousLocalDate:
        (r.last_autonomous_local_date as string | null) ?? null,
      defaultStake: Number(r.default_stake_usdso ?? 1),
      executionMode: r.execution_mode === "paper" ? "paper" : "testnet",
    };
  });
}

export async function setAutonomousEnabled(
  config: AppConfig,
  userId: string,
  enabled: boolean,
  chatId?: number | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    autonomous_enabled: enabled,
    autonomous_paused_at: enabled ? null : new Date().toISOString(),
  };
  if (enabled) {
    patch.autonomous_paused_at = null;
  }
  if (chatId !== undefined && chatId !== null) {
    patch.telegram_chat_id = chatId;
  }
  const { error } = await getSupabaseClient(config)
    .from("user_settings")
    .update(patch)
    .eq("user_id", userId);
  if (error) throw new Error("Unable to update autonomous setting.");
}

export async function pauseAutonomousForLocalDay(
  config: AppConfig,
  userId: string,
  localDate: string,
): Promise<void> {
  const { error } = await getSupabaseClient(config)
    .from("user_settings")
    .update({
      autonomous_paused_at: new Date().toISOString(),
      last_autonomous_local_date: localDate,
    })
    .eq("user_id", userId);
  if (error) throw new Error("Unable to pause autonomous trading.");
}

export async function clearAutonomousPause(
  config: AppConfig,
  userId: string,
  chatId?: number | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    autonomous_paused_at: null,
  };
  if (chatId !== undefined && chatId !== null) {
    patch.telegram_chat_id = chatId;
  }
  const { error } = await getSupabaseClient(config)
    .from("user_settings")
    .update(patch)
    .eq("user_id", userId);
  if (error) throw new Error("Unable to resume autonomous trading.");
}

export async function markAutonomousScan(
  config: AppConfig,
  userId: string,
  timeZone: string,
  now = new Date(),
): Promise<void> {
  const { error } = await getSupabaseClient(config)
    .from("user_settings")
    .update({
      last_autonomous_scan_at: now.toISOString(),
      last_autonomous_local_date: calendarDateInZone(now, timeZone),
    })
    .eq("user_id", userId);
  if (error) throw new Error("Unable to record autonomous scan.");
}

export async function saveUserTimezone(
  config: AppConfig,
  userId: string,
  timeZone: string,
): Promise<string> {
  const normalized = normalizeTimezone(timeZone);
  const { error } = await getSupabaseClient(config)
    .from("user_settings")
    .update({ timezone: normalized })
    .eq("user_id", userId);
  if (error) throw new Error("Unable to save timezone.");
  return normalized;
}

export function shouldRunAutonomousTick(
  row: AutonomousRow,
  now = new Date(),
  minIntervalMs = 14 * 60 * 1000,
): { run: boolean; pauseForNewDay: boolean; reason: string } {
  if (!row.autonomousEnabled) {
    return { run: false, pauseForNewDay: false, reason: "disabled" };
  }
  if (!row.tradingEnabled) {
    return { run: false, pauseForNewDay: false, reason: "trading_disabled" };
  }
  const localDate = calendarDateInZone(now, row.timezone);
  if (row.autonomousPausedAt) {
    return { run: false, pauseForNewDay: false, reason: "paused" };
  }
  if (
    row.lastAutonomousLocalDate &&
    row.lastAutonomousLocalDate !== localDate
  ) {
    return { run: false, pauseForNewDay: true, reason: "local_day_ended" };
  }
  if (row.lastAutonomousScanAt) {
    const last = Date.parse(row.lastAutonomousScanAt);
    if (Number.isFinite(last) && now.getTime() - last < minIntervalMs) {
      return { run: false, pauseForNewDay: false, reason: "interval" };
    }
  }
  return { run: true, pauseForNewDay: false, reason: "ok" };
}

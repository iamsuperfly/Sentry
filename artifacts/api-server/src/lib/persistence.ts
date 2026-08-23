/**
 * Stage 4 Supabase data-access: settings, open positions, realized PnL, trade intents.
 * Server uses service-role; isolation is enforced by always scoping queries to resolved user_id.
 */

import type { AppConfig } from "../config";
import type { TradeIntent, IntentStatus } from "./execution";
import {
  DEFAULT_USER_PREFERENCES,
  type UserRiskPreferences,
  validateUserSettings,
} from "./risk";
import { getSupabaseClient } from "./supabase";
import {
  countOpenPositions,
  OPEN_TRADE_STATUSES,
  sumRealizedPnlUtcDay,
  type TradeRiskRow,
  utcDayBounds,
} from "./trade-accounting";

export type SettingsRow = {
  user_id: string;
  trading_enabled: boolean;
  default_stake_usdso: number | string;
  max_trade_stake_usdso: number | string;
  max_daily_loss_usdso: number | string;
  max_open_positions: number;
  daily_profit_target_usdso: number | string | null;
};

export type TradeRow = {
  id: string;
  user_id: string;
  market_id: string;
  symbol: string;
  direction: string;
  side: string;
  strategy_name: string;
  strategy_version: string | null;
  stake_usdso: number | string;
  contracts: number | string | null;
  limit_price: number | string | null;
  status: IntentStatus;
  idempotency_key: string | null;
  wallet_address: string | null;
  pool_address: string | null;
  decision: unknown;
  reject_reason: string | null;
  pnl_usdso: number | string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

function num(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function settingsRowToPreferences(row: SettingsRow): UserRiskPreferences {
  return {
    tradingEnabled: row.trading_enabled,
    defaultStake: num(row.default_stake_usdso, DEFAULT_USER_PREFERENCES.defaultStake),
    maxTradeStake: num(
      row.max_trade_stake_usdso,
      DEFAULT_USER_PREFERENCES.maxTradeStake,
    ),
    maxDailyLoss: num(
      row.max_daily_loss_usdso,
      DEFAULT_USER_PREFERENCES.maxDailyLoss,
    ),
    maxOpenPositions:
      row.max_open_positions ?? DEFAULT_USER_PREFERENCES.maxOpenPositions,
    dailyProfitTarget:
      row.daily_profit_target_usdso === null ||
      row.daily_profit_target_usdso === undefined
        ? null
        : num(row.daily_profit_target_usdso),
  };
}

/** Resolve internal user_id from Telegram identity only. */
export async function resolveUserIdByTelegram(
  config: AppConfig,
  telegramUserId: number,
): Promise<string | null> {
  const { data, error } = await getSupabaseClient(config)
    .from("telegram_users")
    .select("id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) throw new Error("Unable to resolve Telegram user.");
  return (data?.id as string | undefined) ?? null;
}

export async function getUserSettings(
  config: AppConfig,
  userId: string,
): Promise<UserRiskPreferences> {
  const { data, error } = await getSupabaseClient(config)
    .from("user_settings")
    .select(
      "user_id, trading_enabled, default_stake_usdso, max_trade_stake_usdso, max_daily_loss_usdso, max_open_positions, daily_profit_target_usdso",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Unable to load user settings.");
  if (!data) return { ...DEFAULT_USER_PREFERENCES };
  return settingsRowToPreferences(data as SettingsRow);
}

export async function updateUserSettings(
  config: AppConfig,
  userId: string,
  prefs: UserRiskPreferences,
): Promise<
  | { ok: true; settings: UserRiskPreferences }
  | { ok: false; code: string; reason: string }
> {
  const validated = validateUserSettings(prefs, config.systemLimits);
  if (!validated.ok) {
    return { ok: false, code: validated.code, reason: validated.reason };
  }
  const s = validated.settings;
  const { data, error } = await getSupabaseClient(config)
    .from("user_settings")
    .upsert(
      {
        user_id: userId,
        trading_enabled: s.tradingEnabled,
        default_stake_usdso: s.defaultStake,
        max_trade_stake_usdso: s.maxTradeStake,
        max_daily_loss_usdso: s.maxDailyLoss,
        max_open_positions: s.maxOpenPositions,
        daily_profit_target_usdso: s.dailyProfitTarget,
      },
      { onConflict: "user_id" },
    )
    .select(
      "user_id, trading_enabled, default_stake_usdso, max_trade_stake_usdso, max_daily_loss_usdso, max_open_positions, daily_profit_target_usdso",
    )
    .single();
  if (error || !data) throw new Error("Unable to persist user settings.");
  return { ok: true, settings: settingsRowToPreferences(data as SettingsRow) };
}

export async function fetchOpenPositionCount(
  config: AppConfig,
  userId: string,
): Promise<number> {
  const { count, error } = await getSupabaseClient(config)
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", [...OPEN_TRADE_STATUSES]);
  if (error) throw new Error("Unable to count open positions.");
  return count ?? 0;
}

export async function fetchRealizedPnlToday(
  config: AppConfig,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const { start, end } = utcDayBounds(now);
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("user_id, status, pnl_usdso, settled_at, created_at, updated_at")
    .eq("user_id", userId)
    .not("pnl_usdso", "is", null);
  if (error) throw new Error("Unable to load realized PnL.");
  const rows = (data ?? []) as TradeRiskRow[];
  // Filter by UTC day in application code for consistent settled_at/updated_at handling.
  return sumRealizedPnlUtcDay(rows, userId, now);
}

export async function findTradeByIdempotencyKey(
  config: AppConfig,
  idempotencyKey: string,
): Promise<TradeRow | null> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error("Unable to read trade by idempotency key.");
  return (data as TradeRow | null) ?? null;
}

/**
 * Insert accepted intent. On unique violation of idempotency_key, return existing row.
 */
export async function insertTradeIntent(
  config: AppConfig,
  intent: TradeIntent,
): Promise<{ kind: "created" | "existing"; trade: TradeRow }> {
  const existing = await findTradeByIdempotencyKey(
    config,
    intent.idempotencyKey,
  );
  if (existing) {
    return { kind: "existing", trade: existing };
  }

  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .insert({
      user_id: intent.userId,
      market_id: intent.marketId,
      symbol: intent.symbol,
      direction: intent.direction,
      side: intent.side,
      strategy_name: intent.strategyName,
      strategy_version: intent.strategyVersion,
      stake_usdso: intent.stake,
      contracts: intent.contracts,
      limit_price: intent.limitPrice,
      status: intent.status,
      idempotency_key: intent.idempotencyKey,
      wallet_address: intent.walletAddress,
      pool_address: intent.poolAddress,
      decision: intent.decision,
      reject_reason: intent.rejectReason,
    })
    .select("*")
    .single();

  if (error) {
    // Unique violation → concurrent insert; re-read.
    if (error.code === "23505") {
      const again = await findTradeByIdempotencyKey(
        config,
        intent.idempotencyKey,
      );
      if (again) return { kind: "existing", trade: again };
    }
    throw new Error(`Unable to persist trade intent: ${error.message}`);
  }

  return { kind: "created", trade: data as TradeRow };
}

/** Exported for tests that simulate DB rows without network. */
export { countOpenPositions, sumRealizedPnlUtcDay, utcDayBounds };

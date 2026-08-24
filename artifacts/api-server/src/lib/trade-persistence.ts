import type { AppConfig } from "../config.ts";
import { balances } from "./blockchain.ts";
import {
  DEFAULT_USER_PREFERENCES,
  validateUserSettings,
  type UserRiskPreferences,
  type UserRiskSettings,
} from "./risk.ts";
import type { StrategyDecision } from "./strategy.ts";
import {
  ensureUser,
  findWallet,
  getSupabaseClient,
} from "./supabase.ts";
import {
  buildReentryIdempotencyKey,
  buildTradeIntent,
  type TradeIntent,
} from "./execution.ts";
import {
  getUtcDayBounds,
  isTerminalTradeStatus,
  OPEN_TRADE_STATUSES,
  sumRealizedPnl,
} from "./trade-state.ts";

export type TelegramIdentity = {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
};

export type PersistedUserSettings = UserRiskPreferences & {
  userId: string;
};

type SettingsRow = {
  user_id: string;
  trading_enabled: boolean;
  default_stake_usdso: string | number;
  max_trade_stake_usdso: string | number;
  max_daily_loss_usdso: string | number;
  max_open_positions: number;
  daily_profit_target_usdso: string | number | null;
};

type PersistedTradeRow = {
  id: string;
  user_id: string;
  market_id: string;
  strategy_name: string;
  strategy_version: string;
  direction: "up" | "down";
  status: string;
  [key: string]: unknown;
};

function numeric(value: string | number | null, field: string): number {
  if (value === null) {
    throw new Error(`Supabase returned null for ${field}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Supabase returned an invalid ${field}.`);
  }
  return parsed;
}

function mapSettings(row: SettingsRow): PersistedUserSettings {
  return {
    userId: row.user_id,
    tradingEnabled: row.trading_enabled,
    defaultStake: numeric(row.default_stake_usdso, "default_stake_usdso"),
    maxTradeStake: numeric(row.max_trade_stake_usdso, "max_trade_stake_usdso"),
    maxDailyLoss: numeric(row.max_daily_loss_usdso, "max_daily_loss_usdso"),
    maxOpenPositions: row.max_open_positions,
    dailyProfitTarget:
      row.daily_profit_target_usdso === null
        ? null
        : numeric(row.daily_profit_target_usdso, "daily_profit_target_usdso"),
  };
}

export async function getUserSettings(
  config: AppConfig,
  userId: string,
): Promise<PersistedUserSettings> {
  const { data, error } = await getSupabaseClient(config)
    .from("user_settings")
    .select(
      "user_id, trading_enabled, default_stake_usdso, max_trade_stake_usdso, max_daily_loss_usdso, max_open_positions, daily_profit_target_usdso",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error("Unable to read user settings.");
  if (!data) {
    const { data: created, error: createError } = await getSupabaseClient(config)
      .from("user_settings")
      .insert({ user_id: userId })
      .select(
        "user_id, trading_enabled, default_stake_usdso, max_trade_stake_usdso, max_daily_loss_usdso, max_open_positions, daily_profit_target_usdso",
      )
      .single();
    if (createError || !created) throw new Error("Unable to create user settings.");
    return mapSettings(created as SettingsRow);
  }

  return mapSettings(data as SettingsRow);
}

export async function saveUserSettings(
  config: AppConfig,
  userId: string,
  requested: UserRiskPreferences,
): Promise<PersistedUserSettings> {
  const checked = validateUserSettings(requested, config.systemLimits);
  if (!checked.ok) {
    throw new Error(`${checked.code}: ${checked.reason}`);
  }

  const { data, error } = await getSupabaseClient(config)
    .from("user_settings")
    .upsert(
      {
        user_id: userId,
        trading_enabled: checked.settings.tradingEnabled,
        default_stake_usdso: checked.settings.defaultStake,
        max_trade_stake_usdso: checked.settings.maxTradeStake,
        max_daily_loss_usdso: checked.settings.maxDailyLoss,
        max_open_positions: checked.settings.maxOpenPositions,
        daily_profit_target_usdso: checked.settings.dailyProfitTarget,
      },
      { onConflict: "user_id" },
    )
    .select(
      "user_id, trading_enabled, default_stake_usdso, max_trade_stake_usdso, max_daily_loss_usdso, max_open_positions, daily_profit_target_usdso",
    )
    .single();

  if (error || !data) throw new Error("Unable to save user settings.");
  return mapSettings(data as SettingsRow);
}

export async function saveUserSettingsForTelegram(
  config: AppConfig,
  identity: TelegramIdentity,
  requested: UserRiskPreferences,
): Promise<PersistedUserSettings> {
  const userId = await ensureUser(config, identity);
  return saveUserSettings(config, userId, requested);
}

export async function getOpenPositionCount(
  config: AppConfig,
  userId: string,
): Promise<number> {
  const { count, error } = await getSupabaseClient(config)
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", [...OPEN_TRADE_STATUSES]);

  if (error) throw new Error("Unable to read open positions.");
  return count ?? 0;
}

export async function getRealizedPnlToday(
  config: AppConfig,
  userId: string,
  now = new Date(),
): Promise<number> {
  const { start, end } = getUtcDayBounds(now);

  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("pnl_usdso")
    .eq("user_id", userId)
    .not("pnl_usdso", "is", null)
    .gte("settled_at", start)
    .lt("settled_at", end);

  if (error) throw new Error("Unable to read realized PnL.");
  return sumRealizedPnl(
    (data ?? []) as Array<{ pnl_usdso: string | number | null }>,
  );
}

export async function getTradeByIdempotencyKey(
  config: AppConfig,
  userId: string,
  idempotencyKey: string,
) {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error("Unable to read trade intent.");
  if (!data) return null;
  if ((data as PersistedTradeRow).user_id !== userId) {
    throw new Error("Idempotency key already belongs to another user.");
  }
  return data as PersistedTradeRow;
}

async function getLatestTradeForIntent(
  config: AppConfig,
  intent: TradeIntent,
): Promise<PersistedTradeRow | null> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("*")
    .eq("user_id", intent.userId)
    .eq("market_id", intent.marketId)
    .eq("strategy_name", intent.strategyName)
    .eq("strategy_version", intent.strategyVersion)
    .eq("direction", intent.direction)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error("Unable to read prior trade intents.");
  return data ? (data as PersistedTradeRow) : null;
}

async function insertTradeIntent(
  config: AppConfig,
  intent: TradeIntent,
) {
  return getSupabaseClient(config)
    .from("trades")
    .insert({
      user_id: intent.userId,
      idempotency_key: intent.idempotencyKey,
      strategy_name: intent.strategyName,
      strategy_version: intent.strategyVersion,
      decision: intent.decision,
      stake_usdso: intent.stake,
      contracts: intent.contracts,
      filled_contracts: null,
      limit_price: intent.limitPrice,
      wallet_address: intent.walletAddress,
      market_id: intent.marketId,
      symbol: intent.symbol,
      direction: intent.direction,
      side: intent.side,
      pool_address: intent.poolAddress,
      status: intent.status,
      reject_reason: intent.rejectReason,
    })
    .select("*")
    .single();
}

export async function persistTradeIntent(
  config: AppConfig,
  intent: TradeIntent,
) {
  let candidate = intent;

  for (;;) {
    const { data, error } = await insertTradeIntent(config, candidate);
    if (!error && data) return data;
    if (error?.code !== "23505") {
      throw new Error("Unable to persist trade intent.");
    }

    const keyOwner = await getTradeByIdempotencyKey(
      config,
      intent.userId,
      candidate.idempotencyKey,
    );

    const latest = await getLatestTradeForIntent(config, intent);
    if (latest && !isTerminalTradeStatus(latest.status)) {
      return latest;
    }

    const previousTerminalTrade = latest ?? keyOwner;
    if (!previousTerminalTrade) {
      throw new Error("Unable to resolve conflicting trade intent.");
    }
    if (!isTerminalTradeStatus(previousTerminalTrade.status)) {
      return previousTerminalTrade;
    }

    candidate = {
      ...intent,
      idempotencyKey: buildReentryIdempotencyKey(
        intent.idempotencyKey,
        previousTerminalTrade.id,
      ),
    };
  }
}

export async function createPersistedTradeIntent(input: {
  config: AppConfig;
  identity: TelegramIdentity;
  decision: StrategyDecision;
  stake?: number;
}): Promise<
  | { ok: true; userId: string; trade: unknown; intent: TradeIntent }
  | { ok: false; code: string; reason: string; idempotencyKey: string }
> {
  const userId = await ensureUser(input.config, input.identity);
  const wallet = await findWallet(input.config, input.identity.id);
  if (!wallet) throw new Error("User does not have a wallet.");

  const [storedSettings, openPositionCount, realizedPnlToday, walletBalances] =
    await Promise.all([
      getUserSettings(input.config, userId),
      getOpenPositionCount(input.config, userId),
      getRealizedPnlToday(input.config, userId),
      balances(input.config, wallet.address),
    ]);

  const settings: UserRiskSettings = {
    ...storedSettings,
    openPositionCount,
    realizedPnlToday,
    collateralBalance: Number(walletBalances.tusdc),
  };
  const built = buildTradeIntent({
    userId,
    walletAddress: wallet.address,
    decision: input.decision,
    settings,
    system: input.config.systemLimits,
    stake: input.stake,
  });

  if (!built.ok) return built;

  const trade = await persistTradeIntent(input.config, built.intent);
  return { ok: true, userId, trade, intent: built.intent };
}

export function defaultUserPreferences(): UserRiskPreferences {
  return { ...DEFAULT_USER_PREFERENCES };
}

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
  expirePendingTrade,
  findWallet,
  getSupabaseClient,
} from "./supabase.ts";
import {
  buildReentryIdempotencyKey,
  buildTradeIntent,
  type TradeIntent,
} from "./execution.ts";
import {
  isTerminalTradeStatus,
  isStalePendingIntent,
  OPEN_TRADE_STATUSES,
  TERMINAL_TRADE_STATUSES,
  type PendingIntentMarketState,
  sumRealizedPnl,
} from "./trade-state.ts";
import { setAutonomousEnabled } from "./autonomous-state.ts";
import {
  DEFAULT_USER_TIMEZONE,
  getZonedDayBounds,
  normalizeTimezone,
} from "./user-timezone.ts";

export type TelegramIdentity = {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
};

const SETTINGS_COLUMNS =
  "user_id, trading_enabled, execution_mode, default_stake_usdso, max_trade_stake_usdso, max_daily_loss_usdso, max_open_positions, daily_profit_target_usdso, timezone, autonomous_enabled, autonomous_paused_at";

export async function expireStalePendingTradeIntents(
  config: AppConfig,
  userId: string,
  markets: PendingIntentMarketState[],
  nowSec = Math.floor(Date.now() / 1000),
  readMissingMarket?: (
    marketId: string,
  ) => Promise<PendingIntentMarketState | undefined>,
): Promise<string[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select("id, market_id, status, transaction_hash, filled_contracts")
    .eq("user_id", userId)
    .eq("status", "pending")
    .is("transaction_hash", null)
    .is("filled_contracts", null);
  if (error) throw new Error("Unable to read pending trade intents.");

  const byMarket = new Map(markets.map((market) => [market.marketId, market]));
  const expiredIds: string[] = [];
  for (const row of data ?? []) {
    const market =
      byMarket.get(String(row.market_id)) ??
      (readMissingMarket
        ? await readMissingMarket(String(row.market_id))
        : undefined);
    if (
      !isStalePendingIntent({
        status: String(row.status),
        transactionHash: (row.transaction_hash as string | null) ?? null,
        filledContracts:
          (row.filled_contracts as string | number | null) ?? null,
        market,
        nowSec,
      })
    ) {
      continue;
    }
    const reason =
      "Pending intent expired or its market is no longer tradable; no transaction or fill was recorded.";
    if (
      await expirePendingTrade(config, {
        tradeId: String(row.id),
        userId,
        reason,
      })
    ) {
      expiredIds.push(String(row.id));
    }
  }
  return expiredIds;
}

export async function expireStalePendingTradeIntentsForTelegram(
  config: AppConfig,
  identity: TelegramIdentity,
  markets: PendingIntentMarketState[],
  readMissingMarket?: (
    marketId: string,
  ) => Promise<PendingIntentMarketState | undefined>,
): Promise<string[]> {
  const wallet = await findWallet(config, identity.id);
  if (!wallet) return [];
  return expireStalePendingTradeIntents(
    config,
    wallet.user_id,
    markets,
    undefined,
    readMissingMarket,
  );
}

export type PersistedUserSettings = UserRiskPreferences & {
  userId: string;
  timezone: string;
  autonomousEnabled: boolean;
  autonomousPausedAt: string | null;
};

type SettingsRow = {
  user_id: string;
  trading_enabled: boolean;
  execution_mode: string;
  default_stake_usdso: string | number;
  max_trade_stake_usdso: string | number;
  max_daily_loss_usdso: string | number;
  max_open_positions: number;
  daily_profit_target_usdso: string | number | null;
  timezone?: string | null;
  autonomous_enabled?: boolean | null;
  autonomous_paused_at?: string | null;
};

type PersistedTradeRow = {
  id: string;
  user_id: string;
  market_id: string;
  strategy_name: string;
  strategy_version: string;
  direction: "up" | "down";
  status: string;
  decision?: unknown;
  stake_usdso?: string | number;
  contracts?: string | number;
  limit_price?: string | number;
  wallet_address?: string;
  symbol?: string;
  side?: string;
  pool_address?: string;
  reject_reason?: string | null;
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
  const mode = row.execution_mode === "paper" ? "paper" : "testnet";
  return {
    userId: row.user_id,
    tradingEnabled: row.trading_enabled,
    executionMode: mode,
    defaultStake: numeric(row.default_stake_usdso, "default_stake_usdso"),
    maxTradeStake: numeric(row.max_trade_stake_usdso, "max_trade_stake_usdso"),
    maxDailyLoss: numeric(row.max_daily_loss_usdso, "max_daily_loss_usdso"),
    maxOpenPositions: row.max_open_positions,
    dailyProfitTarget:
      row.daily_profit_target_usdso === null
        ? null
        : numeric(row.daily_profit_target_usdso, "daily_profit_target_usdso"),
    timezone: normalizeTimezone(row.timezone ?? DEFAULT_USER_TIMEZONE),
    autonomousEnabled: Boolean(row.autonomous_enabled),
    autonomousPausedAt: row.autonomous_paused_at ?? null,
  };
}

export async function getUserSettings(
  config: AppConfig,
  userId: string,
): Promise<PersistedUserSettings> {
  const { data, error } = await getSupabaseClient(config)
    .from("user_settings")
    .select(SETTINGS_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error("Unable to read user settings.");
  if (!data) {
    const { data: created, error: createError } = await getSupabaseClient(config)
      .from("user_settings")
      .insert({ user_id: userId })
      .select(SETTINGS_COLUMNS)
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
        execution_mode: checked.settings.executionMode,
        default_stake_usdso: checked.settings.defaultStake,
        max_trade_stake_usdso: checked.settings.maxTradeStake,
        max_daily_loss_usdso: checked.settings.maxDailyLoss,
        max_open_positions: checked.settings.maxOpenPositions,
        daily_profit_target_usdso: checked.settings.dailyProfitTarget,
      },
      { onConflict: "user_id" },
    )
    .select(SETTINGS_COLUMNS)
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
  timeZone?: string,
): Promise<number> {
  const zone =
    timeZone ??
    (await getUserSettings(config, userId).then((s) => s.timezone).catch(
      () => DEFAULT_USER_TIMEZONE,
    ));
  const { start, end } = getZonedDayBounds(now, zone);

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

export async function getTradeIntentForUser(
  config: AppConfig,
  userId: string,
  tradeId: string,
): Promise<TradeIntent | null> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(
      "id, user_id, market_id, strategy_name, strategy_version, direction, status, decision, stake_usdso, contracts, limit_price, wallet_address, symbol, side, pool_address, idempotency_key, reject_reason",
    )
    .eq("id", tradeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Unable to read trade intent.");
  if (!data) return null;

  const row = data as PersistedTradeRow;
  const required = [
    row.wallet_address,
    row.symbol,
    row.side,
    row.pool_address,
    row.idempotency_key,
    row.stake_usdso,
    row.contracts,
    row.limit_price,
  ];
  if (required.some((value) => value === undefined || value === null)) {
    throw new Error("Persisted trade intent is incomplete.");
  }

  return {
    userId: row.user_id,
    idempotencyKey: String(row.idempotency_key),
    strategyName: row.strategy_name,
    strategyVersion: row.strategy_version,
    decision: row.decision as StrategyDecision,
    stake: numeric(row.stake_usdso as string | number, "stake_usdso"),
    contracts: numeric(row.contracts as string | number, "contracts"),
    limitPrice: numeric(row.limit_price as string | number, "limit_price"),
    walletAddress: row.wallet_address as string,
    marketId: row.market_id,
    symbol: row.symbol as string,
    direction: row.direction,
    side: row.side as "buy",
    poolAddress: row.pool_address as string,
    status: row.status as TradeIntent["status"],
    rejectReason: row.reject_reason ?? null,
  };
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

  const storedSettings = await getUserSettings(input.config, userId);
  const [openPositionCount, realizedPnlToday, walletBalances] = await Promise.all([
    getOpenPositionCount(input.config, userId),
    getRealizedPnlToday(input.config, userId, new Date(), storedSettings.timezone),
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

export type TradeSummary = {
  id: string;
  symbol: string;
  direction: string;
  status: string;
  stake: number;
  contracts: number | null;
  filledContracts: number | null;
  limitPrice: number | null;
  marketId: string;
  transactionHash: string | null;
  errorMessage: string | null;
  createdAt: string;
  submittedAt: string | null;
  filledAt: string | null;
};

function mapTradeSummary(row: Record<string, unknown>): TradeSummary {
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: String(row.id),
    symbol: String(row.symbol ?? ""),
    direction: String(row.direction ?? ""),
    status: String(row.status ?? ""),
    stake: Number(row.stake_usdso ?? 0),
    contracts: num(row.contracts),
    filledContracts: num(row.filled_contracts),
    limitPrice: num(row.limit_price),
    marketId: String(row.market_id ?? ""),
    transactionHash: (row.transaction_hash as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    submittedAt: (row.submitted_at as string | null) ?? null,
    filledAt: (row.filled_at as string | null) ?? null,
  };
}

export async function listOpenPositions(
  config: AppConfig,
  userId: string,
  limit = 20,
): Promise<TradeSummary[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(
      "id, symbol, direction, status, stake_usdso, contracts, filled_contracts, limit_price, market_id, transaction_hash, error_message, created_at, submitted_at, filled_at",
    )
    .eq("user_id", userId)
    .in("status", [...OPEN_TRADE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Unable to list open positions.");
  return (data ?? []).map((row) => mapTradeSummary(row as Record<string, unknown>));
}

export async function listTradeHistory(
  config: AppConfig,
  userId: string,
  limit = 20,
): Promise<TradeSummary[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(
      "id, symbol, direction, status, stake_usdso, contracts, filled_contracts, limit_price, market_id, transaction_hash, error_message, created_at, submitted_at, filled_at",
    )
    .eq("user_id", userId)
    .in("status", [...TERMINAL_TRADE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Unable to list trade history.");
  return (data ?? []).map((row) => mapTradeSummary(row as Record<string, unknown>));
}

export async function disableTradingForTelegram(
  config: AppConfig,
  identity: TelegramIdentity,
): Promise<PersistedUserSettings> {
  const userId = await ensureUser(config, identity);
  const current = await getUserSettings(config, userId);
  await setAutonomousEnabled(config, userId, false);
  return saveUserSettings(config, userId, {
    ...current,
    tradingEnabled: false,
  });
}

export async function getUserSettingsForTelegram(
  config: AppConfig,
  identity: TelegramIdentity,
): Promise<PersistedUserSettings> {
  const userId = await ensureUser(config, identity);
  return getUserSettings(config, userId);
}

export function defaultUserPreferences(): UserRiskPreferences {
  return { ...DEFAULT_USER_PREFERENCES };
}

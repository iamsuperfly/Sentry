import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { inferTimezoneFromTelegramLanguage } from "./user-timezone.ts";

let client: SupabaseClient | undefined;

export function getSupabaseClient(config: AppConfig): SupabaseClient {
  client ??= createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  return client;
}

export async function checkSupabaseConnection(
  config: AppConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await getSupabaseClient(config)
    .from("telegram_users")
    .select("id", { count: "exact", head: true });

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

export type WalletRow = {
  id: string;
  user_id: string;
  address: string;
  encrypted_private_key: string;
  chain_id: number;
};

export async function findWallet(config: AppConfig, telegramUserId: number) {
  const client = getSupabaseClient(config);
  const { data, error } = await client
    .from("telegram_users")
    .select("id, user_wallets(*)")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) throw new Error("Unable to read wallet records.");
  const wallet = Array.isArray(data?.user_wallets)
    ? data.user_wallets[0]
    : data?.user_wallets;
  return (wallet as WalletRow | null | undefined) ?? null;
}

export async function ensureUser(
  config: AppConfig,
  from: {
    id: number;
    username?: string;
    first_name: string;
    last_name?: string;
    language_code?: string;
  },
) {
  const client = getSupabaseClient(config);
  const { data, error } = await client
    .from("telegram_users")
    .upsert(
      {
        telegram_user_id: from.id,
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        last_name: from.last_name ?? null,
        is_active: true,
      },
      { onConflict: "telegram_user_id" },
    )
    .select("id")
    .single();
  if (error || !data) throw new Error("Unable to save Telegram user.");
  const { error: settingsError } = await client
    .from("user_settings")
    .upsert({ user_id: data.id }, { onConflict: "user_id" });
  if (settingsError) throw new Error("Unable to save user settings.");

  const inferred = inferTimezoneFromTelegramLanguage(from.language_code);
  await client
    .from("user_settings")
    .update({ timezone: inferred, timezone_source: "auto" })
    .eq("user_id", data.id)
    .eq("timezone_source", "auto");

  return data.id as string;
}

export async function saveWallet(
  config: AppConfig,
  input: {
    userId: string;
    address: string;
    encryptedPrivateKey: string;
  },
) {
  const { data, error } = await getSupabaseClient(config)
    .from("user_wallets")
    .insert({
      user_id: input.userId,
      address: input.address,
      encrypted_private_key: input.encryptedPrivateKey,
      chain_id: 50312,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error("Unable to save wallet securely.");
  return data as WalletRow;
}

export async function createTransaction(
  config: AppConfig,
  input: {
    userId: string;
    walletAddress: string;
    type: string;
    amount: string;
    tokenSymbol: string;
    fromAddress?: string;
    toAddress?: string;
  },
) {
  const { data, error } = await getSupabaseClient(config)
    .from("blockchain_transactions")
    .insert({
      user_id: input.userId,
      wallet_address: input.walletAddress,
      type: input.type,
      amount: input.amount,
      token_symbol: input.tokenSymbol,
      from_address: input.fromAddress ?? null,
      to_address: input.toAddress ?? null,
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error("Unable to create transaction record.");
  return data.id as string;
}

export async function updateTransaction(
  config: AppConfig,
  id: string,
  update: Record<string, unknown>,
) {
  const { error } = await getSupabaseClient(config)
    .from("blockchain_transactions")
    .update(update)
    .eq("id", id);
  if (error) throw new Error("Unable to update transaction record.");
}

export type TradeExecutionUpdate = {
  tradeId: string;
  userId: string;
  status: string;
  fromStatus?: string;
  transactionHash?: string;
  orderId?: string;
  filledContracts?: number;
  errorMessage?: string | null;
};

export async function claimPendingTrade(
  config: AppConfig,
  input: { tradeId: string; userId: string },
): Promise<boolean> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .update({
      status: "submitted",
      submitted_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", input.tradeId)
    .eq("user_id", input.userId)
    .eq("status", "pending")
    .select("id");

  if (error) throw new Error("Unable to claim trade intent.");
  return Array.isArray(data) && data.length === 1;
}

export async function updateTradeExecution(
  config: AppConfig,
  input: TradeExecutionUpdate,
): Promise<void> {
  const update: Record<string, unknown> = {
    status: input.status,
  };
  if (input.transactionHash !== undefined)
    update.transaction_hash = input.transactionHash;
  if (input.orderId !== undefined) update.order_id = input.orderId;
  if (input.filledContracts !== undefined)
    update.filled_contracts = input.filledContracts;
  if (input.errorMessage !== undefined)
    update.error_message = input.errorMessage;
  if (input.status === "submitted")
    update.submitted_at = new Date().toISOString();
  if (input.status === "filled" || input.status === "partially_filled") {
    update.filled_at = new Date().toISOString();
  }

  let query = getSupabaseClient(config)
    .from("trades")
    .update(update)
    .eq("id", input.tradeId)
    .eq("user_id", input.userId);
  if (input.fromStatus) query = query.eq("status", input.fromStatus);

  const { data, error } = await query.select("id");
  if (error) throw new Error("Unable to update trade execution.");
  if (input.fromStatus && (!Array.isArray(data) || data.length !== 1)) {
    throw new Error("Trade execution state changed concurrently.");
  }
}

export async function expirePendingTrade(
  config: AppConfig,
  input: { tradeId: string; userId: string; reason: string },
): Promise<boolean> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .update({
      status: "failed",
      error_message: input.reason,
      reject_reason: input.reason,
    })
    .eq("id", input.tradeId)
    .eq("user_id", input.userId)
    .eq("status", "pending")
    .is("transaction_hash", null)
    .is("filled_contracts", null)
    .select("id");

  if (error) throw new Error("Unable to expire stale trade intent.");
  return Array.isArray(data) && data.length === 1;
}

export async function getOnboardingTransactions(
  config: AppConfig,
  userId: string,
  walletAddress: string,
) {
  const { data, error } = await getSupabaseClient(config)
    .from("blockchain_transactions")
    .select("*")
    .eq("user_id", userId)
    .eq("wallet_address", walletAddress)
    .in("type", ["INITIAL_STT_SPONSOR", "TUSDC_FAUCET"])
    .order("created_at", { ascending: false });
  if (error) throw new Error("Unable to read onboarding transactions.");
  return data as Array<{
    id: string;
    type: "INITIAL_STT_SPONSOR" | "TUSDC_FAUCET";
    transaction_hash: `0x${string}` | null;
    status: "pending" | "submitted" | "confirmed" | "failed";
  }>;
}

export type FaucetAllowance = {
  consumed: string;
  remaining: string;
  limit: string;
  utc_day: string;
};

export async function getFaucetAllowance(config: AppConfig, userId: string) {
  const { data, error } = await getSupabaseClient(config)
    .rpc("get_faucet_allowance", { p_user_id: userId })
    .single();
  if (error || !data) throw new Error("Unable to read faucet allowance.");
  return data as FaucetAllowance;
}

export async function reserveFaucetTransaction(
  config: AppConfig,
  input: {
    userId: string;
    walletAddress: string;
    amount: string;
  },
) {
  const { data, error } = await getSupabaseClient(config)
    .rpc("reserve_faucet_transaction", {
      p_user_id: input.userId,
      p_wallet_address: input.walletAddress,
      p_amount: input.amount,
    })
    .single();
  if (error || !data) {
    if (error?.code === "P0001") throw new Error(error.message);
    throw new Error("Unable to reserve the faucet allowance.");
  }
  return data as FaucetAllowance & { transaction_id: string };
}

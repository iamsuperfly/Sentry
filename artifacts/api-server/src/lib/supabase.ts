import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";

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

export async function ensureUser(config: AppConfig, from: {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
}) {
  const client = getSupabaseClient(config);
  const { data, error } = await client
    .from("telegram_users")
    .upsert({
      telegram_user_id: from.id,
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      last_name: from.last_name ?? null,
      is_active: true,
    }, { onConflict: "telegram_user_id" })
    .select("id")
    .single();
  if (error || !data) throw new Error("Unable to save Telegram user.");
  const { error: settingsError } = await client
    .from("user_settings")
    .upsert({ user_id: data.id }, { onConflict: "user_id" });
  if (settingsError) throw new Error("Unable to save user settings.");
  return data.id as string;
}

export async function saveWallet(config: AppConfig, input: {
  userId: string;
  address: string;
  encryptedPrivateKey: string;
}) {
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

export async function createTransaction(config: AppConfig, input: {
  userId: string;
  walletAddress: string;
  type: string;
  amount: string;
  tokenSymbol: string;
  fromAddress?: string;
  toAddress?: string;
}) {
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

export async function updateTransaction(config: AppConfig, id: string, update: Record<string, unknown>) {
  const { error } = await getSupabaseClient(config)
    .from("blockchain_transactions")
    .update(update)
    .eq("id", id);
  if (error) throw new Error("Unable to update transaction record.");
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
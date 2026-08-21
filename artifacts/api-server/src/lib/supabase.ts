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
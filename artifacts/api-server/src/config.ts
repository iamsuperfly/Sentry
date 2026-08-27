import { z } from "zod";
import {
  resolveSystemLimits,
  type SystemRiskLimits,
} from "./lib/system-limits";

const envSchema = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, "PORT must be a positive integer")
    .default("5000"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SOMNIA_RPC_URL: z.string().url().default("https://dream-rpc.somnia.network"),
  DREAMDEX_INDEXER_URL: z
    .string()
    .url()
    .default("https://dev.smk.somnia.host/v1/graphql"),
  SOMNIA_WS_RPC_URL: z
    .string()
    .url()
    .default("wss://api.infra.testnet.somnia.network/ws"),
  INITIAL_GAS_SPONSOR_AMOUNT: z.string().default("0.1"),
  EXPLORER_TX_BASE_URL: z
    .string()
    .url()
    .default("https://shannon-explorer.somnia.network/tx"),
  TREASURY_PRIVATE_KEY: z.string().min(1, "TREASURY_PRIVATE_KEY is required"),
  WALLET_ENCRYPTION_KEY: z.string().min(1, "WALLET_ENCRYPTION_KEY is required"),
  /** When false (default), Stage 3 only builds intents — no chain orders. */
  ENABLE_LIVE_EXECUTION: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  SYSTEM_MIN_STAKE_TUSDC: z.string().optional(),
  SYSTEM_MAX_STAKE_TUSDC: z.string().optional(),
  SYSTEM_MAX_OPEN_POSITIONS: z.string().optional(),
  SYSTEM_MAX_DAILY_LOSS_TUSDC: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
});

export type AppConfig = {
  port: number;
  telegramBotToken: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  rpcUrl: string;
  dreamdexIndexerUrl: string;
  wsRpcUrl: string;
  initialGasSponsorAmount: string;
  explorerTxBaseUrl: string;
  treasuryPrivateKey: string;
  walletEncryptionKey: string;
  enableLiveExecution: boolean;
  systemLimits: SystemRiskLimits;
  geminiApiKey: string | null;
  geminiModel: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const port = Number(parsed.data.PORT);
  if (port <= 0 || port > 65535) {
    throw new Error(
      "Invalid environment configuration: PORT must be between 1 and 65535",
    );
  }

  return {
    port,
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    rpcUrl: parsed.data.SOMNIA_RPC_URL,
    dreamdexIndexerUrl: parsed.data.DREAMDEX_INDEXER_URL,
    wsRpcUrl: parsed.data.SOMNIA_WS_RPC_URL,
    initialGasSponsorAmount: parsed.data.INITIAL_GAS_SPONSOR_AMOUNT,
    explorerTxBaseUrl: parsed.data.EXPLORER_TX_BASE_URL,
    treasuryPrivateKey: parsed.data.TREASURY_PRIVATE_KEY,
    walletEncryptionKey: parsed.data.WALLET_ENCRYPTION_KEY,
    enableLiveExecution: parsed.data.ENABLE_LIVE_EXECUTION ?? false,
    systemLimits: resolveSystemLimits({
      SYSTEM_MIN_STAKE_TUSDC: parsed.data.SYSTEM_MIN_STAKE_TUSDC,
      SYSTEM_MAX_STAKE_TUSDC: parsed.data.SYSTEM_MAX_STAKE_TUSDC,
      SYSTEM_MAX_OPEN_POSITIONS: parsed.data.SYSTEM_MAX_OPEN_POSITIONS,
      SYSTEM_MAX_DAILY_LOSS_TUSDC: parsed.data.SYSTEM_MAX_DAILY_LOSS_TUSDC,
    }),
    geminiApiKey: parsed.data.GEMINI_API_KEY?.trim() || null,
    geminiModel: parsed.data.GEMINI_MODEL?.trim() || "gemini-flash-latest",
  };
}

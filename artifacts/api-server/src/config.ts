import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().regex(/^\d+$/, "PORT must be a positive integer"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
});

export type AppConfig = {
  port: number;
  telegramBotToken: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
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
    throw new Error("Invalid environment configuration: PORT must be between 1 and 65535");
  }

  return {
    port,
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
  };
}
import { loadConfig } from "./config";
import { createApp } from "./app";
import { logger } from "./lib/logger";
import { startTelegramBot } from "./telegram/bot";
import { registerClaimCommand } from "./telegram/register-claim-command";

const config = loadConfig();
const app = createApp(config);
const bot = startTelegramBot(config);
registerClaimCommand(bot, config);

const server = app.listen(config.port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port: config.port }, "Server listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutdown requested");
  bot.stop();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      logger.error({ err: error }, "Graceful shutdown failed");
      process.exitCode = 1;
    });
  });
}

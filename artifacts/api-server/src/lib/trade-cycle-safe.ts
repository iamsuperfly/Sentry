import { logger } from "./logger.ts";
import {
  runTelegramTradeCycle,
  type OrchestrationResult,
} from "./trade-orchestration.ts";

/**
 * Autonomous and /trade both need the cycle to return a result object.
 * An uncaught throw after "autonomous scan started" is what made every
 * tick look like a hard failure and skipped Telegram notify.
 */
export async function runSafeTelegramTradeCycle(
  input: Parameters<typeof runTelegramTradeCycle>[0],
): Promise<OrchestrationResult> {
  try {
    return await runTelegramTradeCycle(input);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 240)
        : "Unhandled trade cycle error.";
    logger.warn(
      {
        telegramUserId: input.identity?.id,
        knownUserId: input.knownUserId,
        err: message,
        stack: error instanceof Error ? error.stack?.slice(0, 800) : undefined,
      },
      "trade cycle unhandled error",
    );
    return {
      ok: false,
      code: "cycle_unhandled",
      reason: message,
    };
  }
}

import { logger } from "./logger.ts";
import {
  runTelegramTradeCycle,
  type OrchestrationResult,
} from "./trade-orchestration.ts";

/**
 * Autonomous ticks must not die when the cycle throws after
 * "autonomous scan started". Convert any throw to a structured failure
 * so mark/notify/claim still run.
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

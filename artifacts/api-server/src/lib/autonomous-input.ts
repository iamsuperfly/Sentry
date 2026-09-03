import type { AppConfig } from "../config.ts";
import { shouldRequestLiveExecution } from "./telegram-settings.ts";
import type { runSafeTelegramTradeCycle } from "./trade-cycle-safe.ts";
import type { AutonomousRow } from "./autonomous-state.ts";

export function buildAutonomousTradeCycleInput(
  config: AppConfig,
  row: AutonomousRow,
  excludedMarketIds: string[],
): Parameters<typeof runSafeTelegramTradeCycle>[0] {
  return {
    config,
    identity: {
      id: row.telegramUserId,
      username: row.username,
      first_name: row.firstName || "trader",
    },
    liveExecutionRequested: shouldRequestLiveExecution(row.executionMode, true),
    stake: row.defaultStake,
    excludeMarketIds: excludedMarketIds,
  };
}
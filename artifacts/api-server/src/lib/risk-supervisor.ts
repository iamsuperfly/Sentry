/**
 * Day-level trading halt + daily report helpers.
 * Pure — no network. Uses existing realized PnL / performance numbers.
 */

export type DayHaltCode =
  | "trading_disabled"
  | "user_daily_loss_stop"
  | "system_daily_loss_stop"
  | "daily_profit_target_reached";

export type DayHaltInput = {
  tradingEnabled: boolean;
  realizedPnlToday: number;
  maxDailyLoss: number;
  dailyProfitTarget: number | null;
  systemMaxDailyLoss: number;
};

export type DayHaltResult =
  | { halt: false }
  | { halt: true; code: DayHaltCode; reason: string };

export type DayActivity = {
  attempted: number;
  filled: number;
  failed: number;
  cancelled: number;
};

export function evaluateDayHalt(input: DayHaltInput): DayHaltResult {
  if (!input.tradingEnabled) {
    return {
      halt: true,
      code: "trading_disabled",
      reason: "User has trading_enabled=false.",
    };
  }

  const pnl = Number.isFinite(input.realizedPnlToday)
    ? input.realizedPnlToday
    : 0;

  if (pnl <= -input.systemMaxDailyLoss) {
    return {
      halt: true,
      code: "system_daily_loss_stop",
      reason: `System daily loss ceiling reached (pnl=${pnl}, SYSTEM_MAX_DAILY_LOSS_TUSDC=${input.systemMaxDailyLoss}). Resets next UTC day.`,
    };
  }

  if (pnl <= -input.maxDailyLoss) {
    return {
      halt: true,
      code: "user_daily_loss_stop",
      reason: `Daily loss stop reached (pnl=${pnl}, limit=${input.maxDailyLoss}). Resets next UTC day.`,
    };
  }

  const target = input.dailyProfitTarget;
  if (target !== null && target !== undefined && pnl >= target) {
    return {
      halt: true,
      code: "daily_profit_target_reached",
      reason: `Daily profit target ${target} reached (pnl=${pnl}). Resets next UTC day.`,
    };
  }

  return { halt: false };
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n}`;
}

export function formatDayHaltMessage(input: {
  code: DayHaltCode;
  realizedPnlToday: number;
  maxDailyLoss?: number;
  dailyProfitTarget?: number | null;
}): string {
  const pnlLine = `Today's PnL: ${signed(input.realizedPnlToday)} tUSDC`;
  const reset = "Resets at the next UTC midnight.";
  switch (input.code) {
    case "trading_disabled":
      return [
        "⚪ Trading is turned off",
        "",
        "Enable it with /settings trading on, or review /settings.",
      ].join("\n");
    case "user_daily_loss_stop":
      return [
        "⚪ Daily loss limit reached",
        "",
        pnlLine,
        input.maxDailyLoss !== undefined
          ? `Your limit: ${input.maxDailyLoss} tUSDC`
          : "",
        "No new scans or trades until the next UTC day.",
        reset,
      ]
        .filter(Boolean)
        .join("\n");
    case "system_daily_loss_stop":
      return [
        "⚪ System daily loss limit reached",
        "",
        pnlLine,
        "No new scans or trades until the next UTC day.",
        reset,
      ].join("\n");
    case "daily_profit_target_reached":
      return [
        "⚪ Daily profit target reached",
        "",
        pnlLine,
        input.dailyProfitTarget
          ? `Target: ${input.dailyProfitTarget} tUSDC`
          : "",
        "New trades are paused until the next UTC day.",
        reset,
      ]
        .filter(Boolean)
        .join("\n");
  }
}

export function formatAutonomousDailyReport(input: {
  activity: DayActivity;
  dailyPnl: number;
  wins: number;
  losses: number;
  unclaimedPositions: number;
  unclaimedValue: number;
}): string {
  return [
    "Autonomous trading stopped for the UTC day.",
    "",
    "Daily report",
    `Trades attempted: ${input.activity.attempted}`,
    `Filled: ${input.activity.filled}`,
    `Failed: ${input.activity.failed}`,
    `Cancelled: ${input.activity.cancelled}`,
    `Wins: ${input.wins}`,
    `Losses: ${input.losses}`,
    `PnL: ${signed(input.dailyPnl)} tUSDC`,
    `Unclaimed positions: ${input.unclaimedPositions}`,
    `Unclaimed value: ${input.unclaimedValue} tUSDC`,
    "",
    "Send /trade or /auto on to start again tomorrow.",
  ].join("\n");
}

export function summarizeDayActivity(
  rows: Array<{ status: string }>,
): DayActivity {
  const activity: DayActivity = {
    attempted: rows.length,
    filled: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    const s = String(row.status ?? "").toLowerCase();
    if (
      s === "filled" ||
      s === "partially_filled" ||
      s === "settled" ||
      s === "redeemed" ||
      s === "submitted"
    ) {
      activity.filled += 1;
    } else if (s === "failed") {
      activity.failed += 1;
    } else if (s === "cancelled") {
      activity.cancelled += 1;
    }
  }
  return activity;
}

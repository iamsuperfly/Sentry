import { Router, type IRouter } from "express";
import type { AppConfig } from "../config";
import { readDreamdexMarkets } from "../lib/dreamdex";
import {
  assertLiveSubmitAllowed,
  buildTradeIntent,
  planLiveSubmission,
  type IntentStatus,
} from "../lib/execution";
import {
  DEFAULT_USER_PREFERENCES,
  validateUserSettings,
} from "../lib/risk";
import { evaluateMarkets, type StrategyDecision } from "../lib/strategy";

export function createDreamdexRouter(config: AppConfig): IRouter {
  const router = Router();

  router.get("/dreamdex/markets", async (req, res): Promise<void> => {
    const asset =
      typeof req.query.asset === "string" ? req.query.asset : undefined;

    if (asset && !["BTC", "ETH"].includes(asset.toUpperCase())) {
      res.status(400).json({
        error: "asset must be BTC or ETH",
      });
      return;
    }

    try {
      const result = await readDreamdexMarkets(config, asset);
      res.json({
        mode: "read_only",
        ...result,
      });
    } catch (error) {
      req.log.error({ err: error, asset }, "DreamDEX market read failed");
      res.status(502).json({
        mode: "read_only",
        error: "DreamDEX market data is unavailable.",
      });
    }
  });

  router.get("/dreamdex/decisions", async (req, res): Promise<void> => {
    const asset =
      typeof req.query.asset === "string" ? req.query.asset : undefined;

    if (asset && !["BTC", "ETH"].includes(asset.toUpperCase())) {
      res.status(400).json({
        error: "asset must be BTC or ETH",
      });
      return;
    }

    try {
      const snapshot = await readDreamdexMarkets(config, asset);
      const strategy = evaluateMarkets(snapshot.markets);
      res.json({
        mode: "strategy_only",
        execution: false,
        network: snapshot.network,
        marketCounts: {
          discovered: snapshot.discoveredCount,
          supported: snapshot.supportedCount,
          tradable: snapshot.tradableCount,
        },
        ...strategy,
      });
    } catch (error) {
      req.log.error({ err: error, asset }, "DreamDEX strategy evaluation failed");
      res.status(502).json({
        mode: "strategy_only",
        execution: false,
        error: "DreamDEX strategy evaluation is unavailable.",
      });
    }
  });

  /**
   * Stage 3 dry-run: build a trade intent from a Stage 2 decision body.
   * Applies system ceilings + user prefs. Does not sign or broadcast.
   */
  router.post("/dreamdex/intents/preview", async (req, res): Promise<void> => {
    const body = req.body as {
      userId?: string;
      walletAddress?: string;
      decision?: StrategyDecision;
      stake?: number;
      settings?: {
        tradingEnabled?: boolean;
        defaultStake?: number;
        maxTradeStake?: number;
        maxDailyLoss?: number;
        maxOpenPositions?: number;
        dailyProfitTarget?: number | null;
        executionMode?: "paper" | "testnet";
        realizedPnlToday?: number;
        openPositionCount?: number;
        collateralBalance?: number;
      };
      existingStatus?: IntentStatus;
      liveExecution?: boolean;
    };

    if (!body.userId || !body.walletAddress || !body.decision) {
      res.status(400).json({
        error: "userId, walletAddress, and decision are required",
      });
      return;
    }

    const settings = {
      tradingEnabled:
        body.settings?.tradingEnabled ?? DEFAULT_USER_PREFERENCES.tradingEnabled,
      defaultStake:
        body.settings?.defaultStake ?? DEFAULT_USER_PREFERENCES.defaultStake,
      maxTradeStake:
        body.settings?.maxTradeStake ?? DEFAULT_USER_PREFERENCES.maxTradeStake,
      maxDailyLoss:
        body.settings?.maxDailyLoss ?? DEFAULT_USER_PREFERENCES.maxDailyLoss,
      maxOpenPositions:
        body.settings?.maxOpenPositions ??
        DEFAULT_USER_PREFERENCES.maxOpenPositions,
      dailyProfitTarget:
        body.settings?.dailyProfitTarget === undefined
          ? DEFAULT_USER_PREFERENCES.dailyProfitTarget
          : body.settings.dailyProfitTarget,
      executionMode:
        body.settings?.executionMode ?? DEFAULT_USER_PREFERENCES.executionMode,
      realizedPnlToday: body.settings?.realizedPnlToday ?? 0,
      openPositionCount: body.settings?.openPositionCount ?? 0,
      collateralBalance: body.settings?.collateralBalance ?? 0,
    };

    const built = buildTradeIntent({
      userId: body.userId,
      walletAddress: body.walletAddress,
      decision: body.decision,
      settings,
      system: config.systemLimits,
      stake: body.stake,
      existing: body.existingStatus
        ? { status: body.existingStatus, idempotencyKey: "existing" }
        : null,
    });

    if (!built.ok) {
      res.status(409).json({
        mode: "execution_preview",
        ok: false,
        code: built.code,
        reason: built.reason,
        idempotencyKey: built.idempotencyKey,
        systemLimits: config.systemLimits,
        liveExecutionEnabled: config.enableLiveExecution,
      });
      return;
    }

    const liveGate = assertLiveSubmitAllowed({
      enableLiveExecution: config.enableLiveExecution,
      liveExecutionRequested: body.liveExecution === true,
    });

    res.json({
      mode: "execution_preview",
      ok: true,
      intent: built.intent,
      systemLimits: config.systemLimits,
      submissionPlan: planLiveSubmission(built.intent),
      liveSubmit: liveGate.ok
        ? { allowed: true }
        : { allowed: false, code: liveGate.code, reason: liveGate.reason },
      note: "Shannon collateral is tUSDC. Protocol tick/lot checks run only on live submit. ENABLE_LIVE_EXECUTION remains the chain gate.",
    });
  });

  /** Validate user risk preferences against system ceilings (no trade). */
  router.post("/dreamdex/settings/validate", async (req, res): Promise<void> => {
    const body = req.body as {
      tradingEnabled?: boolean;
      defaultStake?: number;
      maxTradeStake?: number;
      maxDailyLoss?: number;
      maxOpenPositions?: number;
      dailyProfitTarget?: number | null;
      executionMode?: "paper" | "testnet";
    };

    const result = validateUserSettings(
      {
        tradingEnabled: body.tradingEnabled ?? false,
        defaultStake: body.defaultStake ?? DEFAULT_USER_PREFERENCES.defaultStake,
        maxTradeStake:
          body.maxTradeStake ?? DEFAULT_USER_PREFERENCES.maxTradeStake,
        maxDailyLoss: body.maxDailyLoss ?? DEFAULT_USER_PREFERENCES.maxDailyLoss,
        maxOpenPositions:
          body.maxOpenPositions ?? DEFAULT_USER_PREFERENCES.maxOpenPositions,
        dailyProfitTarget:
          body.dailyProfitTarget === undefined
            ? null
            : body.dailyProfitTarget,
        executionMode: body.executionMode ?? DEFAULT_USER_PREFERENCES.executionMode,
      },
      config.systemLimits,
    );

    if (!result.ok) {
      res.status(400).json({
        ok: false,
        code: result.code,
        reason: result.reason,
        systemLimits: config.systemLimits,
      });
      return;
    }

    res.json({
      ok: true,
      settings: result.settings,
      systemLimits: config.systemLimits,
    });
  });

  return router;
}

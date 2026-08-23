import { Router, type IRouter } from "express";
import type { AppConfig } from "../config";
import { readDreamdexMarkets } from "../lib/dreamdex";
import {
  assertLiveSubmitAllowed,
  buildTradeIntent,
  planLiveSubmission,
  type IntentStatus,
} from "../lib/execution";
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
   * Does not sign or broadcast. Does not write Supabase in this handler yet
   * (persistence wires in when the bot path is enabled).
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
      tradingEnabled: body.settings?.tradingEnabled ?? false,
      defaultStake: body.settings?.defaultStake ?? 1,
      maxTradeStake: body.settings?.maxTradeStake ?? 1,
      maxDailyLoss: body.settings?.maxDailyLoss ?? 10,
      maxOpenPositions: body.settings?.maxOpenPositions ?? 1,
      realizedPnlToday: body.settings?.realizedPnlToday ?? 0,
      openPositionCount: body.settings?.openPositionCount ?? 0,
      collateralBalance: body.settings?.collateralBalance ?? 0,
    };

    const built = buildTradeIntent({
      userId: body.userId,
      walletAddress: body.walletAddress,
      decision: body.decision,
      settings,
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
      submissionPlan: planLiveSubmission(built.intent),
      liveSubmit: liveGate.ok
        ? { allowed: true }
        : { allowed: false, code: liveGate.code, reason: liveGate.reason },
      note: "Per-user wallet signing exists (encrypted keys). Chain submit remains gated by ENABLE_LIVE_EXECUTION.",
    });
  });

  return router;
}

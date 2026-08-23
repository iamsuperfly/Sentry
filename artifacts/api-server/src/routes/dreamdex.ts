import { Router, type IRouter } from "express";
import type { AppConfig } from "../config";
import { readDreamdexMarkets } from "../lib/dreamdex";
import { evaluateMarkets } from "../lib/strategy";

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

  /**
   * Stage 2: pure strategy decisions over Stage 1 market snapshots.
   * Read-only — no orders, keys, or database writes.
   */
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

  return router;
}

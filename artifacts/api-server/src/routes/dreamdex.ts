import { Router, type IRouter } from "express";
import type { AppConfig } from "../config";
import { readDreamdexMarkets } from "../lib/dreamdex";

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

  return router;
}
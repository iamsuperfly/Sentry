import { Router, type IRouter } from "express";
import type { AppConfig } from "../config";
import { checkSupabaseConnection } from "../lib/supabase";

export function createStatusRouter(config: AppConfig): IRouter {
  const router: IRouter = Router();

  router.get("/readyz", async (req, res): Promise<void> => {
    const supabase = await checkSupabaseConnection(config);

    if (!supabase.ok) {
      req.log.error({ error: supabase.error }, "Supabase readiness check failed");
      res.status(503).json({
        status: "not_ready",
        dependencies: { supabase: "unavailable" },
      });
      return;
    }

    res.json({
      status: "ok",
      dependencies: { supabase: "ok" },
      network: { name: "Somnia Shannon testnet", chainId: 50312 },
    });
  });

  return router;
}
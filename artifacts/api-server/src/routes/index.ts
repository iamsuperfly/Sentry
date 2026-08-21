import { Router, type IRouter } from "express";
import healthRouter from "./health";
import type { AppConfig } from "../config";
import { createStatusRouter } from "./status";

export function createRouter(config: AppConfig): IRouter {
  const router: IRouter = Router();

  router.use(healthRouter);
  router.use(createStatusRouter(config));

  return router;
}

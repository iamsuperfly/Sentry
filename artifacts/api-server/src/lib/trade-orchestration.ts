/**
 * Production execution wiring (Stage 6 entry boundary).
 *
 * Production: 1m (Binance spot ±0.05%) then 15m+ Groq → validate → risk → persist → execute.
 * Unit tests may inject `evaluate` for the legacy edge-taker path.
 */

import type { AppConfig } from "../config.ts";
import type { DreamdexDiagnostic } from "./dreamdex.ts";
import { attachMarketWindowMeta } from "./decision-market-meta.ts";
import type { LiveSubmitResult } from "./live-execution.ts";
import type { StrategyDecision, StrategyRunResult } from "./strategy.ts";
import { summarizeMarketIntelligence } from "./market-intelligence.ts";
import {
  callGroqMarketDecisions,
  isGroqConfigured,
} from "./groq-client.ts";
import { validateAiCandidates } from "./ai-decision-validate.ts";
import {
  geminiCandidateToStrategyDecision,
  marketEligibleForGemini,
  toGeminiMarketInput,
} from "./gemini-path.ts";
import { extractBookTop, secondsToExpiry } from "./strategy.ts";
import { logger } from "./logger.ts";
import {
  evaluateOneMinMarketWithBinance,
  marketInOneMinFinalWindow,
  oneMinEnterToStrategyDecision,
} from "./one-min-runtime.ts";
import type { TelegramIdentity } from "./trade-persistence.ts";
import {
  getOpenPositionCount,
  getRealizedPnlToday,
  getUserSettings,
} from "./trade-persistence.ts";
import { remainingDailyLossBudget } from "./adaptive-stake.ts";
import { ensureUser } from "./supabase.ts";
import {
  computeAvailableSlots,
  processAiCandidateTrades,
  type CandidateTradeAttempt,
} from "./multi-ai-execution.ts";

export const ORCHESTRATION_MODULE = "stage-6-execution-wiring";

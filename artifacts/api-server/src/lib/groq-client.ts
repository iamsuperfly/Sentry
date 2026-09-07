/**
 * Groq client for structured trading decisions (OpenAI-compatible Chat Completions).
 * Real HTTP only — no hard-coded fake AI responses.
 */

import { prepareGroqMarkets } from "./groq-prompt.ts";

export type AiMarketInput = {
  marketId: string;
  asset: string;
  question?: string;
  strike?: string;
  durationBucket: string;
  intervalSec: number | null;
  windowSec: number | null;
  tradingStart?: string;
  expiry?: string;
  referenceType?: "strike" | "opening";
  referencePrice?: number;
  referenceDecimals?: number | null;
  secondsToExpiry: number | null;
  tradable: boolean;
  finalized: boolean;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  spread: number | null;
  topAskQuantity: number | null;
  yesAskQuantity?: number | null;
  noAskQuantity?: number | null;
  spot?: number;
  gapBps?: number;
  tradeCount?: number | null;
};

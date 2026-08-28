/**
 * Groq client for structured trading decisions (OpenAI-compatible Chat Completions).
 * Real HTTP only — no hard-coded fake AI responses.
 */

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
  secondsToExpiry: number | null;
  tradable: boolean;
  finalized: boolean;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  spread: number | null;
  topAskQuantity: number | null;
  tradeCount?: number | null;
};

/** @deprecated Prefer AiMarketInput — kept for gemini-path compatibility aliases. */
export type GeminiMarketInput = AiMarketInput;

export type AiCandidateDecision = {
  marketId: string;
  direction: "UP" | "DOWN";
  confidence: number;
  reason: string;
  stake: number | null;
};

export type AiAuditRecord = {
  provider: "groq";
  model: string;
  startedAt: string;
  latencyMs: number;
  marketsSupplied: number;
  snapshotHash: string;
  decisionsReturned: number;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  decisions?: AiCandidateDecision[];
};

export type AiCallResult =
  | {
      ok: true;
      decisions: AiCandidateDecision[];
      audit: AiAuditRecord;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      audit: AiAuditRecord;
    };

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
export const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";

function snapshotHash(markets: AiMarketInput[]): string {
  const ids = markets.map((m) => m.marketId).sort().join(",");
  let h = 0;
  for (let i = 0; i < ids.length; i++) {
    h = (Math.imul(31, h) + ids.charCodeAt(i)) | 0;
  }
  return `mh_${(h >>> 0).toString(16)}`;
}

export function isGroqConfigured(env: {
  apiKey?: string | null;
}): boolean {
  return Boolean(env.apiKey && env.apiKey.trim().length > 0);
}

function buildPrompt(markets: AiMarketInput[], availableSlots: number): string {
  return [
    "You are a binary event-contract trading analyst for BTC/ETH up/down markets.",
    "Use ONLY the market data provided. Do not invent prices, markets, or liquidity.",
    `You may propose at most ${availableSlots} ENTER decisions (available position slots).`,
    "Prefer SKIP when edge/liquidity/time is unclear. stake may be null to use user default.",
    "Return JSON matching the schema: { decisions: [{ marketId, direction UP|DOWN, confidence 0-1, reason, stake number|null }] }.",
    "Empty decisions array means no trade.",
    "",
    "Markets:",
    JSON.stringify(markets, null, 0),
  ].join("\n");
}

/** JSON Schema for Groq structured outputs (strict-friendly). */
const DECISIONS_JSON_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          marketId: { type: "string" },
          direction: { type: "string", enum: ["UP", "DOWN"] },
          confidence: { type: "number" },
          reason: { type: "string" },
          stake: {
            anyOf: [{ type: "number" }, { type: "null" }],
          },
        },
        required: ["marketId", "direction", "confidence", "reason", "stake"],
        additionalProperties: false,
      },
    },
  },
  required: ["decisions"],
  additionalProperties: false,
};

function parseDecisions(raw: unknown): AiCandidateDecision[] | null {
  if (!raw || typeof raw !== "object") return null;
  const decisions = (raw as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) return null;
  const out: AiCandidateDecision[] = [];
  for (const d of decisions) {
    if (!d || typeof d !== "object") continue;
    const row = d as Record<string, unknown>;
    const marketId = typeof row.marketId === "string" ? row.marketId : null;
    const direction =
      row.direction === "UP" || row.direction === "DOWN" ? row.direction : null;
    const confidence =
      typeof row.confidence === "number" ? row.confidence : Number(row.confidence);
    const reason = typeof row.reason === "string" ? row.reason : "";
    let stake: number | null = null;
    if (row.stake === null || row.stake === undefined) stake = null;
    else if (typeof row.stake === "number" && Number.isFinite(row.stake))
      stake = row.stake;
    else {
      const n = Number(row.stake);
      stake = Number.isFinite(n) ? n : null;
    }
    if (!marketId || !direction || !Number.isFinite(confidence)) continue;
    out.push({
      marketId,
      direction,
      confidence,
      reason: reason.slice(0, 500),
      stake,
    });
  }
  return out;
}

function truncateProviderErrorBody(raw: string, maxLen: number): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; type?: string; code?: string };
    };
    const msg = parsed.error?.message?.trim();
    if (msg) {
      return msg.length > maxLen ? `${msg.slice(0, maxLen)}…` : msg;
    }
  } catch {
    // not JSON
  }
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

export async function callGroqMarketDecisions(input: {
  apiKey: string;
  model: string;
  markets: AiMarketInput[];
  availableSlots: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AiCallResult> {
  const model = input.model.trim() || DEFAULT_GROQ_MODEL;
  const baseUrl = (input.baseUrl ?? DEFAULT_GROQ_BASE_URL).replace(/\/$/, "");
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const hash = snapshotHash(input.markets);
  const baseAudit: Omit<AiAuditRecord, "latencyMs" | "ok" | "decisionsReturned"> =
    {
      provider: "groq",
      model,
      startedAt,
      marketsSupplied: input.markets.length,
      snapshotHash: hash,
    };

  if (!input.apiKey.trim()) {
    return {
      ok: false,
      code: "ai_not_configured",
      reason: "AI not configured (GROQ_API_KEY missing).",
      audit: {
        ...baseAudit,
        latencyMs: 0,
        ok: false,
        decisionsReturned: 0,
        errorCode: "ai_not_configured",
        errorMessage: "GROQ_API_KEY is missing.",
      },
    };
  }

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: buildPrompt(input.markets, input.availableSlots),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "trade_decisions",
        strict: true,
        schema: DECISIONS_JSON_SCHEMA,
      },
    },
  };

  console.info(
    {
      provider: "groq",
      model,
      marketsSupplied: input.markets.length,
      snapshotHash: hash,
      availableSlots: input.availableSlots,
    },
    "AI request started",
  );

  const fetchFn = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 25_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      const safeDetail = truncateProviderErrorBody(text, 280);
      console.warn(
        {
          provider: "groq",
          model,
          latencyMs,
          status: res.status,
          detail: safeDetail || undefined,
        },
        "AI request failed",
      );
      return {
        ok: false,
        code: "ai_http_error",
        reason: safeDetail
          ? `Groq HTTP ${res.status}: ${safeDetail}`
          : `Groq HTTP ${res.status}.`,
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "ai_http_error",
          errorMessage: safeDetail
            ? `HTTP ${res.status}: ${safeDetail}`
            : `HTTP ${res.status}`,
        },
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      console.warn(
        { provider: "groq", model, latencyMs },
        "AI response was not JSON",
      );
      return {
        ok: false,
        code: "ai_invalid_response",
        reason: "Groq response was not valid JSON.",
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "ai_invalid_response",
          errorMessage: "Response not JSON",
        },
      };
    }

    const choices = (parsedJson as { choices?: unknown[] }).choices;
    const first =
      Array.isArray(choices) && choices.length > 0 ? choices[0] : null;
    const content =
      first &&
      typeof first === "object" &&
      (first as { message?: { content?: unknown } }).message?.content;

    if (typeof content !== "string" || !content.trim()) {
      return {
        ok: false,
        code: "ai_empty_response",
        reason: "Groq returned no message content.",
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "ai_empty_response",
        },
      };
    }

    let structured: unknown;
    try {
      structured = JSON.parse(content);
    } catch {
      return {
        ok: false,
        code: "ai_invalid_json",
        reason: "Groq message content was not valid JSON.",
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "ai_invalid_json",
        },
      };
    }

    const decisions = parseDecisions(structured);
    if (decisions === null) {
      return {
        ok: false,
        code: "ai_schema_mismatch",
        reason: "Groq JSON did not match expected decisions shape.",
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "ai_schema_mismatch",
        },
      };
    }

    console.info(
      {
        provider: "groq",
        model,
        latencyMs,
        marketsSupplied: input.markets.length,
        decisionsReturned: decisions.length,
        snapshotHash: hash,
      },
      "AI request completed",
    );

    return {
      ok: true,
      decisions,
      audit: {
        ...baseAudit,
        latencyMs,
        ok: true,
        decisionsReturned: decisions.length,
        decisions,
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === "AbortError";
    const code = aborted ? "ai_timeout" : "ai_network_error";
    const reason = aborted
      ? "Groq request timed out."
      : "Groq network error.";
    console.warn({ provider: "groq", model, latencyMs, code }, reason);
    return {
      ok: false,
      code,
      reason,
      audit: {
        ...baseAudit,
        latencyMs,
        ok: false,
        decisionsReturned: 0,
        errorCode: code,
        errorMessage: reason,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

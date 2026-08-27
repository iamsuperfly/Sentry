/**
 * Google Gemini client for structured trading decisions.
 * Real HTTP calls only — no hard-coded fake AI responses.
 */

export type GeminiMarketInput = {
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

export type GeminiCandidateDecision = {
  marketId: string;
  direction: "UP" | "DOWN";
  confidence: number;
  reason: string;
  stake: number | null;
};

export type GeminiStructuredResponse = {
  decisions: GeminiCandidateDecision[];
};

export type GeminiAuditRecord = {
  provider: "gemini";
  model: string;
  startedAt: string;
  latencyMs: number;
  marketsSupplied: number;
  snapshotHash: string;
  decisionsReturned: number;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  decisions?: GeminiCandidateDecision[];
};

export type GeminiCallResult =
  | {
      ok: true;
      decisions: GeminiCandidateDecision[];
      audit: GeminiAuditRecord;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      audit: GeminiAuditRecord;
    };

function snapshotHash(markets: GeminiMarketInput[]): string {
  const ids = markets.map((m) => m.marketId).sort().join(",");
  let h = 0;
  for (let i = 0; i < ids.length; i++) {
    h = (Math.imul(31, h) + ids.charCodeAt(i)) | 0;
  }
  return `mh_${(h >>> 0).toString(16)}`;
}

export function isGeminiConfigured(env: {
  apiKey?: string | null;
}): boolean {
  return Boolean(env.apiKey && env.apiKey.trim().length > 0);
}

function buildPrompt(markets: GeminiMarketInput[], availableSlots: number): string {
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

const RESPONSE_SCHEMA = {
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
          // OpenAPI/proto Schema: single type + nullable (not JSON Schema type arrays).
          stake: { type: "number", nullable: true },
        },
        required: ["marketId", "direction", "confidence", "reason"],
      },
    },
  },
  required: ["decisions"],
};

function parseDecisions(raw: unknown): GeminiCandidateDecision[] | null {
  if (!raw || typeof raw !== "object") return null;
  const decisions = (raw as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) return null;
  const out: GeminiCandidateDecision[] = [];
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
    else if (typeof row.stake === "number" && Number.isFinite(row.stake)) stake = row.stake;
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

/** Extract a short, non-secret detail from a Gemini error JSON/text body. */
function truncateGeminiErrorBody(raw: string, maxLen: number): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; status?: string; code?: number };
    };
    const msg = parsed.error?.message?.trim();
    if (msg) {
      return msg.length > maxLen ? `${msg.slice(0, maxLen)}…` : msg;
    }
  } catch {
    // not JSON — fall through
  }
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

export async function callGeminiMarketDecisions(input: {
  apiKey: string;
  model: string;
  markets: GeminiMarketInput[];
  availableSlots: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<GeminiCallResult> {
  const model = input.model.trim() || "gemini-flash-latest";
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const hash = snapshotHash(input.markets);
  const baseAudit: Omit<
    GeminiAuditRecord,
    "latencyMs" | "ok" | "decisionsReturned"
  > = {
    provider: "gemini",
    model,
    startedAt,
    marketsSupplied: input.markets.length,
    snapshotHash: hash,
  };

  if (!input.apiKey.trim()) {
    const audit: GeminiAuditRecord = {
      ...baseAudit,
      latencyMs: 0,
      ok: false,
      decisionsReturned: 0,
      errorCode: "gemini_not_configured",
      errorMessage: "GEMINI_API_KEY is missing.",
    };
    return {
      ok: false,
      code: "gemini_not_configured",
      reason: "AI not configured (GEMINI_API_KEY missing).",
      audit,
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [
      { parts: [{ text: buildPrompt(input.markets, input.availableSlots) }] },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  };

  console.info(
    {
      provider: "gemini",
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
        "X-goog-api-key": input.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      const safeDetail = truncateGeminiErrorBody(text, 280);
      console.warn(
        {
          provider: "gemini",
          model,
          latencyMs,
          status: res.status,
          detail: safeDetail || undefined,
        },
        "AI request failed",
      );
      return {
        ok: false,
        code: "gemini_http_error",
        reason: safeDetail
          ? `Gemini HTTP ${res.status}: ${safeDetail}`
          : `Gemini HTTP ${res.status}.`,
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "gemini_http_error",
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
        { provider: "gemini", model, latencyMs },
        "AI response was not JSON",
      );
      return {
        ok: false,
        code: "gemini_invalid_response",
        reason: "Gemini response was not valid JSON.",
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "gemini_invalid_response",
          errorMessage: "Response not JSON",
        },
      };
    }

    const candidates = (parsedJson as { candidates?: unknown[] }).candidates;
    const first =
      Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : null;
    const parts =
      first &&
      typeof first === "object" &&
      (first as { content?: { parts?: unknown } }).content?.parts;
    const textPart =
      Array.isArray(parts) && parts.length > 0
        ? (parts[0] as { text?: string }).text
        : undefined;

    if (typeof textPart !== "string" || !textPart.trim()) {
      return {
        ok: false,
        code: "gemini_empty_response",
        reason: "Gemini returned no text content.",
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "gemini_empty_response",
        },
      };
    }

    let structured: unknown;
    try {
      structured = JSON.parse(textPart);
    } catch {
      return {
        ok: false,
        code: "gemini_invalid_json",
        reason: "Gemini text part was not valid JSON.",
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "gemini_invalid_json",
        },
      };
    }

    const decisions = parseDecisions(structured);
    if (decisions === null) {
      return {
        ok: false,
        code: "gemini_schema_mismatch",
        reason: "Gemini JSON did not match expected decisions shape.",
        audit: {
          ...baseAudit,
          latencyMs,
          ok: false,
          decisionsReturned: 0,
          errorCode: "gemini_schema_mismatch",
        },
      };
    }

    console.info(
      {
        provider: "gemini",
        model,
        latencyMs,
        marketsSupplied: input.markets.length,
        decisionsReturned: decisions.length,
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
    const code = aborted ? "gemini_timeout" : "gemini_network_error";
    const reason = aborted
      ? "Gemini request timed out."
      : "Gemini network error.";
    console.warn({ provider: "gemini", model, latencyMs, code }, reason);
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

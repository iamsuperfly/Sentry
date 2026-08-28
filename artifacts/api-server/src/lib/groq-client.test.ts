import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callGroqMarketDecisions,
  isGroqConfigured,
  DEFAULT_GROQ_MODEL,
} from "./groq-client.ts";

describe("groq client", () => {
  it("detects missing key", () => {
    assert.equal(isGroqConfigured({ apiKey: "" }), false);
    assert.equal(isGroqConfigured({ apiKey: "  " }), false);
    assert.equal(isGroqConfigured({ apiKey: "gsk_x" }), true);
  });

  it("fails closed when key empty without pretending AI success", async () => {
    const r = await callGroqMarketDecisions({
      apiKey: "",
      model: DEFAULT_GROQ_MODEL,
      markets: [],
      availableSlots: 1,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "ai_not_configured");
      assert.match(r.reason, /GROQ_API_KEY|not configured/i);
    }
  });

  it("maps successful structured response to candidates", async () => {
    const r = await callGroqMarketDecisions({
      apiKey: "test-key",
      model: DEFAULT_GROQ_MODEL,
      markets: [
        {
          marketId: "m1",
          asset: "BTC",
          durationBucket: "15m",
          intervalSec: 900,
          windowSec: 900,
          secondsToExpiry: 500,
          tradable: true,
          finalized: false,
          yesBid: 0.4,
          yesAsk: 0.42,
          noBid: null,
          noAsk: null,
          spread: 0.02,
          topAskQuantity: 1,
        },
      ],
      availableSlots: 1,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decisions: [
                      {
                        marketId: "m1",
                        direction: "UP",
                        confidence: 0.7,
                        reason: "ask cheap vs time",
                        stake: null,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.decisions.length, 1);
      assert.equal(r.decisions[0]?.marketId, "m1");
      assert.equal(r.decisions[0]?.direction, "UP");
      assert.equal(r.decisions[0]?.stake, null);
      assert.equal(r.audit.provider, "groq");
    }
  });

  it("rejects malformed message content safely", async () => {
    const r = await callGroqMarketDecisions({
      apiKey: "test-key",
      model: DEFAULT_GROQ_MODEL,
      markets: [],
      availableSlots: 1,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "not-json{" } }],
          }),
          { status: 200 },
        ),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "ai_invalid_json");
  });

  it("includes truncated provider error on HTTP failure", async () => {
    const body = JSON.stringify({
      error: {
        message: "Rate limit exceeded for model openai/gpt-oss-20b",
        type: "rate_limit_exceeded",
      },
    });
    const r = await callGroqMarketDecisions({
      apiKey: "test-key",
      model: DEFAULT_GROQ_MODEL,
      markets: [],
      availableSlots: 1,
      fetchImpl: async () =>
        new Response(body, { status: 429, statusText: "Too Many Requests" }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "ai_http_error");
      assert.match(r.reason, /Rate limit/i);
      assert.match(r.audit.errorMessage ?? "", /Rate limit/i);
    }
  });

  it("sends Authorization Bearer without exposing key in audit", async () => {
    let auth: string | null = null;
    await callGroqMarketDecisions({
      apiKey: "secret-key-value",
      model: DEFAULT_GROQ_MODEL,
      markets: [],
      availableSlots: 1,
      fetchImpl: async (_url, init) => {
        const h = init?.headers as Record<string, string> | undefined;
        auth = h?.Authorization ?? null;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ decisions: [] }) } },
            ],
          }),
          { status: 200 },
        );
      },
    });
    assert.equal(auth, "Bearer secret-key-value");
  });
});

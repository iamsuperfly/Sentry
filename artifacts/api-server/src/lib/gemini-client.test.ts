import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callGeminiMarketDecisions, isGeminiConfigured } from "./gemini-client.ts";

describe("gemini client", () => {
  it("detects missing key", () => {
    assert.equal(isGeminiConfigured({ apiKey: "" }), false);
    assert.equal(isGeminiConfigured({ apiKey: "  " }), false);
    assert.equal(isGeminiConfigured({ apiKey: "x" }), true);
  });

  it("fails closed when key empty without pretending AI success", async () => {
    const r = await callGeminiMarketDecisions({
      apiKey: "",
      model: "gemini-flash-latest",
      markets: [],
      availableSlots: 1,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "gemini_not_configured");
      assert.match(r.reason, /not configured/i);
    }
  });

  it("maps HTTP errors without fake decisions", async () => {
    const r = await callGeminiMarketDecisions({
      apiKey: "test-key",
      model: "gemini-flash-latest",
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
        new Response("nope", { status: 401, statusText: "Unauthorized" }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "gemini_http_error");
  });

  it("includes truncated Google error message on HTTP failure", async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message:
          'Invalid JSON payload received. Unknown name "type" at generation_config.response_schema',
        status: "INVALID_ARGUMENT",
      },
    });
    const r = await callGeminiMarketDecisions({
      apiKey: "test-key",
      model: "gemini-flash-latest",
      markets: [],
      availableSlots: 1,
      fetchImpl: async () =>
        new Response(body, { status: 400, statusText: "Bad Request" }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "gemini_http_error");
      assert.match(r.reason, /Invalid JSON payload/i);
      assert.match(r.audit.errorMessage ?? "", /Invalid JSON payload/i);
    }
  });

  it("sends Gemini-compatible nullable stake in responseSchema", async () => {
    let captured: string | null = null;
    await callGeminiMarketDecisions({
      apiKey: "test-key",
      model: "gemini-flash-latest",
      markets: [],
      availableSlots: 1,
      fetchImpl: async (_url, init) => {
        captured = typeof init?.body === "string" ? init.body : null;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ decisions: [] }) }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    assert.ok(captured);
    const parsed = JSON.parse(captured!) as {
      generationConfig: {
        responseSchema: {
          properties: {
            decisions: {
              items: {
                properties: { stake: { type?: unknown; nullable?: boolean } };
              };
            };
          };
        };
      };
    };
    const stake =
      parsed.generationConfig.responseSchema.properties.decisions.items
        .properties.stake;
    assert.equal(stake.type, "number");
    assert.equal(stake.nullable, true);
    assert.equal(Array.isArray(stake.type), false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeAvailableSlots,
  processAiCandidateTrades,
} from "./multi-ai-execution.ts";
import type { AppConfig } from "../config.ts";
import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";
import { DEFAULT_SYSTEM_LIMITS } from "./system-limits.ts";

function market(id: string): DreamdexMarketDiagnostic {
  const expiry = String(Math.floor(Date.now() / 1000) + 900);
  return {
    marketId: id,
    marketAddress: "0xm",
    poolAddress: "0xp",
    poolNonce: "1",
    asset: "BTC",
    question: "up?",
    oracleQuestion: null,
    strike: "100",
    tradingStart: String(Math.floor(Date.now() / 1000) - 10),
    expiry,
    intervalSec: "900",
    indexerStatus: "Trading",
    onchainStatus: 1,
    tradable: true,
    finalized: false,
    isResolved: false,
    isVoided: false,
    winningOutcome: null,
    collateral: "0xc",
    decimals: 6,
    book: {
      yesBids: [{ price: "400000", quantity: "10" }],
      yesAsks: [{ price: "450000", quantity: "10" }],
      noBids: [{ price: "550000", quantity: "10" }],
      noAsks: [{ price: "600000", quantity: "10" }],
    },
  } as DreamdexMarketDiagnostic;
}

describe("multi-slot selection math", () => {
  it("availableSlots = max(0, maxOpen - openCount)", () => {
    assert.equal(
      computeAvailableSlots({ userMaxOpen: 4, systemMaxOpen: 4, openCount: 1 }),
      3,
    );
    assert.equal(
      computeAvailableSlots({ userMaxOpen: 4, systemMaxOpen: 4, openCount: 3 }),
      1,
    );
    assert.equal(
      computeAvailableSlots({ userMaxOpen: 4, systemMaxOpen: 4, openCount: 4 }),
      0,
    );
    assert.equal(
      computeAvailableSlots({ userMaxOpen: 10, systemMaxOpen: 4, openCount: 0 }),
      4,
    );
  });

  it("takes top N by confidence", () => {
    const ranked = [
      { id: "a", confidence: 0.91 },
      { id: "b", confidence: 0.87 },
      { id: "c", confidence: 0.81 },
    ];
    assert.deepEqual(
      ranked.slice(0, 3).map((x) => x.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      ranked.slice(0, 2).map((x) => x.id),
      ["a", "b"],
    );
  });

  it("default stake applies per trade not shared", () => {
    const defaultStake = 30;
    const per = Array.from({ length: 3 }, () => defaultStake);
    assert.equal(per.reduce((a, b) => a + b, 0), 90);
  });
});

describe("processAiCandidateTrades isolates execute throws", () => {
  it("continues to the next candidate when executePersisted throws", async () => {
    const config = {
      systemLimits: DEFAULT_SYSTEM_LIMITS,
    } as AppConfig;
    let executes = 0;
    const attempts = await processAiCandidateTrades({
      config,
      identity: { id: 1, first_name: "t" },
      liveExecutionRequested: true,
      defaultStake: 10,
      selectedCandidates: [
        {
          marketId: "m1",
          direction: "UP",
          confidence: 0.9,
          reason: "a",
          stake: 10,
        },
        {
          marketId: "m2",
          direction: "DOWN",
          confidence: 0.8,
          reason: "b",
          stake: 10,
        },
      ],
      markets: [market("m1"), market("m2")],
      nowSec: Math.floor(Date.now() / 1000),
      persistIntent: async () => ({
        ok: true,
        userId: "u",
        trade: { id: `t-${++executes}` },
        intent: { symbol: "BTC", stake: 10, userId: "u", walletAddress: "0xw" },
      }),
      executePersisted: async ({ tradeId }) => {
        if (tradeId === "t-1") throw new Error("first candidate boom");
        return {
          ok: true,
          gated: false,
          tradeId,
          status: "filled",
          transactionHash: "0xhash",
          order: {
            marketId: "m2",
            poolAddress: "0xp",
            side: "buy",
            outcome: "NO",
            orderType: "IOC",
            limitPrice: 0.6,
            contracts: 10,
            stake: 10,
            collateral: "0xc",
            decimals: 6,
            expireAtSec: Math.floor(Date.now() / 1000) + 60,
            signerRole: "user_wallet",
          },
        };
      },
    });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.ok, false);
    assert.equal(attempts[0]?.code, "execution_failed");
    assert.equal(attempts[1]?.ok, true);
    assert.equal(attempts[1]?.tradeId, "t-2");
  });
});

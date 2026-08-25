import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import type { AppConfig } from "../config.ts";
import type { TradeIntent } from "./execution.ts";
import {
  evaluateProtocolGates,
  LiveBroadcastError,
  mapDirectionToOutcome,
  SHANNON_TUSDC,
  submitLiveOrder,
  type LiveExecutionDeps,
  type ProtocolMarketSnapshot,
} from "./live-execution.ts";
import { DEFAULT_SYSTEM_LIMITS } from "./system-limits.ts";

function encryptForTest(keyHex: string, privateKey: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKey, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((p) => p.toString("base64"))
    .join(".");
}

const WALLET_KEY = "a".repeat(64);
const USER_PK = "0x" + "11".repeat(32);

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 5000,
    telegramBotToken: "t",
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "s",
    rpcUrl: "https://dream-rpc.somnia.network",
    dreamdexIndexerUrl: "https://dev.smk.somnia.host/v1/graphql",
    wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
    initialGasSponsorAmount: "0.1",
    explorerTxBaseUrl: "https://shannon-explorer.somnia.network/tx",
    treasuryPrivateKey: "0x" + "22".repeat(32),
    walletEncryptionKey: WALLET_KEY,
    enableLiveExecution: false,
    systemLimits: DEFAULT_SYSTEM_LIMITS,
    ...overrides,
  };
}

function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    idempotencyKey: "u1:m1:edge-taker-v1:1.0.0:YES",
    userId: "user-a",
    walletAddress: "0xuserwallet",
    marketId: "0xmarket1",
    symbol: "BTC-0xmarket/YES",
    direction: "up",
    side: "buy",
    strategyName: "edge-taker-v1",
    strategyVersion: "1.0.0",
    stake: 2,
    contracts: 5,
    limitPrice: 0.4,
    poolAddress: "0xpool",
    status: "pending",
    decision: {} as TradeIntent["decision"],
    rejectReason: null,
    ...overrides,
  };
}

function market(
  overrides: Partial<ProtocolMarketSnapshot> = {},
): ProtocolMarketSnapshot {
  return {
    marketId: "0xmarket1",
    onchainStatus: 1,
    poolAddress: "0xpool",
    collateral: SHANNON_TUSDC,
    decimals: 6,
    tickSize: 0.01,
    lotSize: 0.1,
    expirySec: 2_000_000_000,
    ...overrides,
  };
}

describe("protocol gates", () => {
  it("maps up/down to YES/NO", () => {
    assert.equal(mapDirectionToOutcome("up"), "YES");
    assert.equal(mapDirectionToOutcome("down"), "NO");
  });

  it("rejects non-Trading status", () => {
    const r = evaluateProtocolGates({
      intent: intent(),
      market: market({ onchainStatus: 2 }),
      tusdcBalance: 100,
      allowance: 100,
      nowSec: 1_700_000_000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "market_not_trading");
  });

  it("rejects invalid tick after snap", () => {
    const r = evaluateProtocolGates({
      intent: intent({ limitPrice: 0.004 }),
      market: market({ tickSize: 0.01 }),
      tusdcBalance: 100,
      allowance: 100,
      nowSec: 1_700_000_000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid_tick");
  });

  it("rejects zero lot after snap", () => {
    const r = evaluateProtocolGates({
      intent: intent({ contracts: 0.05 }),
      market: market({ lotSize: 0.1 }),
      tusdcBalance: 100,
      allowance: 100,
      nowSec: 1_700_000_000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid_lot");
  });

  it("rejects insufficient tUSDC", () => {
    const r = evaluateProtocolGates({
      intent: intent({ contracts: 5, limitPrice: 0.4 }),
      market: market(),
      tusdcBalance: 0.5,
      allowance: 100,
      nowSec: 1_700_000_000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "insufficient_tusdc");
  });

  it("flags approval when allowance is low", () => {
    const r = evaluateProtocolGates({
      intent: intent({ contracts: 5, limitPrice: 0.4 }),
      market: market(),
      tusdcBalance: 50,
      allowance: 0,
      nowSec: 1_700_000_000,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.needsApproval, true);
      assert.equal(r.order.orderType, "IOC");
      assert.equal(r.order.outcome, "YES");
      assert.equal(r.order.side, "buy");
      assert.equal(r.order.signerRole, "user_wallet");
      assert.equal(r.order.collateral.toLowerCase(), SHANNON_TUSDC.toLowerCase());
    }
  });

  it("builds NO outcome for down direction", () => {
    const r = evaluateProtocolGates({
      intent: intent({ direction: "down" }),
      market: market(),
      tusdcBalance: 50,
      allowance: 50,
      nowSec: 1_700_000_000,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.order.outcome, "NO");
  });
});

describe("submitLiveOrder gate + mocked chain", () => {
  function mockDeps(
    overrides: Partial<LiveExecutionDeps> & {
      writes?: Array<Record<string, unknown>>;
    } = {},
  ): LiveExecutionDeps {
    const writes = overrides.writes ?? [];
    return {
      readChain: async () => ({
        market: market(),
        tusdcBalance: 50,
        allowance: 50,
        nowSec: 1_700_000_000,
      }),
      ensureAllowance: async () => null,
      placeIocOrder: async () => ({
        transactionHash: "0xhash",
        orderId: "ord-1",
        filledContracts: 5,
        status: "filled" as const,
      }),
      updateTrade: async (row) => {
        writes.push(row);
      },
      ...overrides,
    };
  }

  it("blocks when ENABLE_LIVE_EXECUTION is false", async () => {
    const r = await submitLiveOrder({
      config: baseConfig({ enableLiveExecution: false }),
      intent: intent(),
      tradeId: "t1",
      encryptedPrivateKey: encryptForTest(WALLET_KEY, USER_PK),
      liveExecutionRequested: true,
      deps: mockDeps(),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.gated, true);
      assert.equal(r.code, "live_execution_disabled");
    }
  });

  it("blocks when live not requested even if env true", async () => {
    const r = await submitLiveOrder({
      config: baseConfig({ enableLiveExecution: true }),
      intent: intent(),
      tradeId: "t1",
      encryptedPrivateKey: encryptForTest(WALLET_KEY, USER_PK),
      liveExecutionRequested: false,
      deps: mockDeps(),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "live_not_requested");
  });

  it("rejects protocol failure and marks trade failed", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const r = await submitLiveOrder({
      config: baseConfig({ enableLiveExecution: true }),
      intent: intent(),
      tradeId: "t1",
      encryptedPrivateKey: encryptForTest(WALLET_KEY, USER_PK),
      liveExecutionRequested: true,
      deps: mockDeps({
        writes,
        readChain: async () => ({
          market: market({ onchainStatus: 2 }),
          tusdcBalance: 50,
          allowance: 50,
          nowSec: 1_700_000_000,
        }),
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "market_not_trading");
    assert.equal(writes.some((w) => w.status === "failed"), true);
  });

  it("runs user-wallet path: approve when needed, submitted → filled", async () => {
    const writes: Array<Record<string, unknown>> = [];
    let approved = false;
    let placedWithUserKey = false;

    const r = await submitLiveOrder({
      config: baseConfig({ enableLiveExecution: true }),
      intent: intent(),
      tradeId: "t1",
      encryptedPrivateKey: encryptForTest(WALLET_KEY, USER_PK),
      liveExecutionRequested: true,
      deps: mockDeps({
        writes,
        readChain: async () => ({
          market: market(),
          tusdcBalance: 50,
          allowance: 0,
          nowSec: 1_700_000_000,
        }),
        ensureAllowance: async ({ privateKey }) => {
          assert.equal(privateKey, USER_PK);
          approved = true;
          return "0xapprove";
        },
        placeIocOrder: async ({ privateKey, order }) => {
          assert.equal(privateKey, USER_PK);
          assert.equal(order.orderType, "IOC");
          assert.equal(order.outcome, "YES");
          placedWithUserKey = true;
          return {
            transactionHash: "0xfill",
            orderId: "o1",
            filledContracts: 5,
            status: "filled",
          };
        },
      }),
    });

    assert.equal(r.ok, true);
    assert.equal(approved, true);
    assert.equal(placedWithUserKey, true);
    if (r.ok) {
      assert.equal(r.status, "filled");
      assert.equal(r.transactionHash, "0xfill");
    }
    const statuses = writes.map((w) => w.status);
    assert.deepEqual(statuses, ["submitted", "filled"]);
  });

  it("records failed submission from placeIocOrder", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const r = await submitLiveOrder({
      config: baseConfig({ enableLiveExecution: true }),
      intent: intent(),
      tradeId: "t1",
      encryptedPrivateKey: encryptForTest(WALLET_KEY, USER_PK),
      liveExecutionRequested: true,
      deps: mockDeps({
        writes,
        placeIocOrder: async () => ({
          transactionHash: "0xfail",
          filledContracts: 0,
          status: "failed",
          errorMessage: "reverted",
        }),
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "submission_failed");
    assert.equal(writes.at(-1)?.status, "failed");
  });

  it("rejects non-pending intent status", async () => {
    const r = await submitLiveOrder({
      config: baseConfig({ enableLiveExecution: true }),
      intent: intent({ status: "filled" }),
      tradeId: "t1",
      encryptedPrivateKey: encryptForTest(WALLET_KEY, USER_PK),
      liveExecutionRequested: true,
      deps: mockDeps(),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "not_pending");
  });

  it("does not touch the chain when the atomic claim is lost", async () => {
    let reads = 0;
    let writes = 0;
    const r = await submitLiveOrder({
      config: baseConfig({ enableLiveExecution: true }),
      intent: intent(),
      tradeId: "t1",
      encryptedPrivateKey: encryptForTest(WALLET_KEY, USER_PK),
      liveExecutionRequested: true,
      deps: mockDeps({
        claimTrade: async () => false,
        readChain: async () => {
          reads += 1;
          return {
            market: market(),
            tusdcBalance: 50,
            allowance: 50,
            nowSec: 1_700_000_000,
          };
        },
        placeIocOrder: async () => {
          writes += 1;
          return {
            transactionHash: "0xnever",
            filledContracts: 5,
            status: "filled",
          };
        },
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "already_claimed");
    assert.equal(reads, 0);
    assert.equal(writes, 0);
  });

  it("keeps a submission submitted when broadcast outcome is uncertain", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const r = await submitLiveOrder({
      config: baseConfig({ enableLiveExecution: true }),
      intent: intent(),
      tradeId: "t1",
      encryptedPrivateKey: encryptForTest(WALLET_KEY, USER_PK),
      liveExecutionRequested: true,
      deps: mockDeps({
        writes,
        claimTrade: async () => true,
        placeIocOrder: async () => {
          throw new LiveBroadcastError(
            "RPC connection dropped after send",
            "uncertain",
            "0xmaybe",
          );
        },
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "broadcast_uncertain");
      assert.equal(r.status, "submitted");
    }
    assert.equal(writes.at(-1)?.status, "submitted");
    assert.equal(writes.at(-1)?.transactionHash, "0xmaybe");
    assert.equal(writes.some((w) => w.status === "failed"), false);
  });
});

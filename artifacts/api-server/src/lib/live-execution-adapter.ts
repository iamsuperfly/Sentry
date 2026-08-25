import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SomniaMarkets,
  ORDER_TYPE,
  type Trader,
} from "@somnia-chain/markets-sdk";
import {
  somniaShannon,
} from "@somnia-chain/markets-sdk/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import type { AppConfig } from "../config.ts";
import type { TradeIntent } from "./execution.ts";
import type { PendingIntentMarketState } from "./trade-state.ts";
import {
  LiveBroadcastError,
  type ChainReadSnapshot,
  type ChainWriteResult,
  type IocOrderDraft,
  type LiveExecutionDeps,
} from "./live-execution.ts";
import { claimPendingTrade, updateTradeExecution } from "./supabase.ts";

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function exchange(config: AppConfig) {
  return new SomniaMarkets({
    chain: somniaShannon,
    wsRpcUrl: config.wsRpcUrl,
    indexerUrl: config.dreamdexIndexerUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });
}

function rawToHuman(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function address(value: string): Address {
  return value as Address;
}

function errorHash(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["hash", "transactionHash", "txHash"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function toBroadcastError(error: unknown, operation: string): LiveBroadcastError {
  const hash = errorHash(error);
  const message =
    error instanceof Error ? error.message.slice(0, 240) : `${operation} failed`;
  // A reverted receipt is a proven failure; send/RPC failures are not.
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  const confirmed = /revert|contractrevert|execution reverted/i.test(
    `${name} ${message}`,
  );
  return new LiveBroadcastError(
    message,
    confirmed ? "confirmed_failure" : hash ? "uncertain" : "uncertain",
    hash,
  );
}

async function makeTrader(config: AppConfig, privateKey: string): Promise<{
  trader: Trader;
  account: ReturnType<typeof privateKeyToAccount>;
}> {
  const account = privateKeyToAccount(privateKey as Hex);
  const client = exchange(config);
  return { trader: client.client.createTrader({ privateKey: privateKey as Hex }), account };
}

export function createProductionLiveExecutionDeps(
  config: AppConfig,
): LiveExecutionDeps {
  return {
    readChain: async (intent: TradeIntent): Promise<ChainReadSnapshot> => {
      const client = exchange(config).client;
      const market = await client.getMarketOnchain(intent.marketId as Hex);
      const params = await client.getBinaryBookParams(market.pool);
      const [balance, allowance] = await Promise.all([
        client.getErc20Balance(market.collateral, address(intent.walletAddress)),
        client.getErc20Allowance(
          market.collateral,
          address(intent.walletAddress),
          market.pool,
        ),
      ]);
      return {
        market: {
          marketId: intent.marketId,
          onchainStatus: market.status,
          poolAddress: market.pool,
          collateral: market.collateral,
          decimals: market.decimals,
          tickSize: rawToHuman(params.tickSize, market.decimals),
          lotSize: rawToHuman(params.lotSize, market.decimals),
          expirySec: Number(market.expiry),
        },
        tusdcBalance: rawToHuman(balance, market.decimals),
        allowance: rawToHuman(allowance, market.decimals),
        nowSec: Math.floor(Date.now() / 1000),
      };
    },

    ensureAllowance: async ({ privateKey, collateral, pool, amount, decimals }) => {
      const { account } = await makeTrader(config, privateKey);
      const publicClient = createPublicClient({
        chain: somniaShannon,
        transport: http(config.rpcUrl),
      });
      const walletClient = createWalletClient({
        account,
        chain: somniaShannon,
        transport: http(config.rpcUrl),
      });
      try {
        const hash = await walletClient.writeContract({
          address: address(collateral),
          abi: erc20Abi,
          functionName: "approve",
          args: [address(pool), parseUnits(String(amount), decimals)],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        return hash;
      } catch (error) {
        throw toBroadcastError(error, "Collateral approval");
      }
    },

    placeIocOrder: async ({
      privateKey,
      order,
    }): Promise<ChainWriteResult> => {
      const { trader } = await makeTrader(config, privateKey);
      const decimals = order.decimals;
      const price = parseUnits(String(order.limitPrice), decimals);
      const quantity = parseUnits(String(order.contracts), decimals);
      try {
        const result = await trader.placeOrder({
          pool: address(order.poolAddress),
          side: order.outcome === "YES" ? "BUY_YES" : "BUY_NO",
          price,
          quantity,
          orderType: ORDER_TYPE.MARKET,
          expireTimestampNs: BigInt(order.expireAtSec) * 1_000_000_000n,
          autoApprove: false,
        });
        const filled = result.fills.reduce(
          (total, fill) => total + rawToHuman(fill.quantityFilled, decimals),
          0,
        );
        return {
          transactionHash: result.hash,
          orderId: result.orderId?.toString(),
          filledContracts: filled,
          status:
            filled <= 0
              ? "failed"
              : filled >= order.contracts
                ? "filled"
                : "partially_filled",
        };
      } catch (error) {
        throw toBroadcastError(error, "IOC order");
      }
    },

    claimTrade: ({ tradeId, userId }) =>
      claimPendingTrade(config, { tradeId, userId }),
    updateTrade: (input) => updateTradeExecution(config, input),
  };
}

export async function readPendingMarketState(
  config: AppConfig,
  marketId: string,
): Promise<PendingIntentMarketState> {
  const marketClient = exchange(config);
  try {
    const market = await marketClient.client.getMarketOnchain(marketId as Hex);
    return {
      marketId,
      expiry: market.expiry.toString(),
      indexerStatus: "Unknown",
      onchainStatus: market.status,
      tradable: market.status === 1,
      finalized: market.finalized,
    };
  } finally {
    await Promise.race([
      marketClient.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}
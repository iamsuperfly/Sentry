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
  ORDER_TYPE,
} from "@somnia-chain/markets-sdk";
import {
  somniaShannon,
} from "@somnia-chain/markets-sdk/chains";
import type { AppConfig } from "../config.ts";
import type { TradeIntent } from "./execution.ts";
import type { PendingIntentMarketState } from "./trade-state.ts";
import {
  LiveBroadcastError,
  type ChainReadSnapshot,
  type ChainWriteResult,
  type LiveExecutionDeps,
} from "./live-execution.ts";
import { claimPendingTrade, updateTradeExecution } from "./supabase.ts";
import { evaluatePreflightBook, levelFromBookSide, type PreflightBook } from "./preflight-book.ts";
import { logger } from "./logger.ts";
import { looksLikeInsufficientGas, looksLikePostOnlyWouldCross } from "./insufficient-gas.ts";
import { replenishUserSttGas } from "./gas-replenish.ts";
import { rememberWindow } from "./market-window.ts";
import { getSharedSomniaExchange, withUserWriteSession } from "./somnia-client.ts";
import { classifySdkFailure } from "./sdk-failure.ts";
import { postOnlyWouldCross } from "./post-only-order.ts";

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

function rawToHuman(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function address(value: string): Address {
  return value as Address;
}

function toBroadcastError(
  error: unknown,
  operation: string,
  context?: Record<string, unknown>,
): LiveBroadcastError {
  const classified = classifySdkFailure(error, operation);
  logger.error(
    {
      operation: classified.operation,
      sdkName: classified.name,
      err: classified.message,
      hash: classified.hash,
      broadcastState: classified.broadcastState,
      ...context,
    },
    "Somnia/DreamDEX SDK call failed",
  );
  if (looksLikeInsufficientGas(classified.name, classified.message)) {
    return new LiveBroadcastError(
      classified.message,
      "confirmed_failure",
      classified.hash,
    );
  }
  if (looksLikePostOnlyWouldCross(classified.name, classified.message)) {
    return new LiveBroadcastError(
      classified.message,
      "confirmed_failure",
      classified.hash,
    );
  }
  return new LiveBroadcastError(
    classified.message,
    classified.broadcastState,
    classified.hash,
  );
}

async function readBookSnapshot(
  config: AppConfig,
  poolAddress: string,
  decimals: number,
): Promise<PreflightBook> {
  const client = getSharedSomniaExchange(config).client;
  const book = await client.getBinaryOrderBook(address(poolAddress), {
    depth: 5,
    decimals,
  });
  const levels = (entries: Array<{ price: bigint; quantity: bigint }>) =>
    entries.map(({ price, quantity }) => ({
      price: price.toString(),
      quantity: quantity.toString(),
    }));
  return {
    yesAsk: levelFromBookSide(levels(book.yesAsks), decimals),
    noAsk: levelFromBookSide(levels(book.noAsks), decimals),
  };
}

export function createProductionLiveExecutionDeps(
  config: AppConfig,
): LiveExecutionDeps {
  return {
    readChain: async (intent: TradeIntent): Promise<ChainReadSnapshot> => {
      const client = getSharedSomniaExchange(config).client;
      const market = await client.getMarketOnchain(intent.marketId as Hex);
      const params = await client.getBinaryBookParams(market.pool);
      if (!params || params.tickSize <= 0n || params.lotSize <= 0n || params.minQuantity <= 0n) {
        throw new Error("Pool tickSize, lotSize, and minQuantity are required.");
      }
      rememberWindow({
        marketId: intent.marketId,
        poolAddress: market.pool,
        poolNonce: market.nonce === undefined || market.nonce === null ? "" : String(market.nonce),
      });
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
          minQuantity: rawToHuman(params.minQuantity, market.decimals),
          tickSizeRaw: params.tickSize,
          lotSizeRaw: params.lotSize,
          minQuantityRaw: params.minQuantity,
          expirySec: Number(market.expiry),
        },
        tusdcBalance: rawToHuman(balance, market.decimals),
        allowance: rawToHuman(allowance, market.decimals),
        nowSec: Math.floor(Date.now() / 1000),
      };
    },

    readBook: async (order) => readBookSnapshot(config, order.poolAddress, order.decimals),

    ensureAllowance: async ({ privateKey, collateral, pool, amount, decimals }) => {
      const account = privateKeyToAccount(privateKey as Hex);
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
        throw toBroadcastError(error, "Collateral approval", {
          walletAddress: account.address,
          pool,
          collateral,
        });
      }
    },

    placeIocOrder: async ({
      privateKey,
      order,
    }): Promise<ChainWriteResult> => {
      let fresh: PreflightBook;
      try {
        fresh = await readBookSnapshot(config, order.poolAddress, order.decimals);
      } catch (error) {
        const classified = classifySdkFailure(error, "Pre-flight book read");
        logger.warn(
          {
            marketId: order.marketId,
            operation: classified.operation,
            sdkName: classified.name,
            err: classified.message,
          },
          "Pre-flight book read failed; skipping IOC",
        );
        return {
          filledContracts: 0,
          status: "failed",
          errorMessage: classified.message,
        };
      }
      const pre = evaluatePreflightBook({
        outcome: order.outcome,
        limitPrice: order.limitPrice,
        contracts: order.contracts,
        book: fresh,
      });
      logger.info(
        {
          marketId: order.marketId,
          side: order.outcome,
          oldLimit: order.limitPrice,
          freshAsk: pre.askPrice,
          availableQuantity: pre.askQuantity,
          decision: pre.ok ? "proceed" : "skip",
          reason: pre.ok ? "fresh book executable" : pre.reason,
        },
        "Pre-flight order book",
      );
      if (!pre.ok) {
        return {
          filledContracts: 0,
          status: "failed",
          errorMessage: pre.reason,
        };
      }

      return withUserWriteSession(config, privateKey, async ({ trader, address: walletAddress }) => {
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
          throw toBroadcastError(error, "IOC order", {
            marketId: order.marketId,
            poolAddress: order.poolAddress,
            walletAddress,
            outcome: order.outcome,
            limitPrice: order.limitPrice,
            contracts: order.contracts,
          });
        }
      });
    },

    placePostOnlyOrder: async ({ privateKey, order }): Promise<ChainWriteResult> => {
      const decimals = order.decimals;
      const quantity = parseUnits(String(order.contracts), decimals);
      if (quantity <= 0n) {
        return {
          filledContracts: 0,
          status: "failed",
          errorMessage: "POST_ONLY quantity snaps to zero; no order signed.",
        };
      }
      let book: PreflightBook | null = null;
      try {
        book = await readBookSnapshot(config, order.poolAddress, decimals);
      } catch (error) {
        const classified = classifySdkFailure(error, "POST_ONLY book read");
        logger.warn(
          {
            marketId: order.marketId,
            operation: classified.operation,
            sdkName: classified.name,
            err: classified.message,
          },
          "POST_ONLY book read failed; not signing",
        );
        return {
          filledContracts: 0,
          status: "failed",
          errorMessage: classified.message,
        };
      }
      if (postOnlyWouldCross({
        outcome: order.outcome,
        limitPrice: order.limitPrice,
        book,
      })) {
        return {
          filledContracts: 0,
          status: "failed",
          errorMessage: `POST_ONLY would cross at limit ${order.limitPrice}.`,
        };
      }
      return withUserWriteSession(config, privateKey, async ({ trader, address: walletAddress }) => {
        const price = parseUnits(String(order.limitPrice), decimals);
        try {
          const result = await trader.placeOrder({
            pool: address(order.poolAddress),
            side: order.outcome === "YES" ? "BUY_YES" : "BUY_NO",
            price,
            quantity,
            orderType: ORDER_TYPE.POST_ONLY,
            expireTimestampNs: BigInt(order.expireAtSec) * 1_000_000_000n,
            autoApprove: false,
          });
          const filled = result.fills.reduce(
            (total, fill) => total + rawToHuman(fill.quantityFilled, decimals),
            0,
          );
          if (filled <= 0 && result.orderId) {
            return {
              transactionHash: result.hash,
              orderId: result.orderId.toString(),
              filledContracts: 0,
              status: "resting",
            };
          }
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
          throw toBroadcastError(error, "POST_ONLY order", {
            marketId: order.marketId,
            poolAddress: order.poolAddress,
            walletAddress,
            outcome: order.outcome,
            limitPrice: order.limitPrice,
            contracts: order.contracts,
          });
        }
      });
    },

    replenishGas: async ({ userId, walletAddress }) => {
      const result = await replenishUserSttGas({
        config,
        userId,
        walletAddress,
      });
      if (!result.ok) return result;
      return { ok: true, hash: result.hash };
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
  const client = getSharedSomniaExchange(config).client;
  const market = await client.getMarketOnchain(marketId as Hex);
  return {
    marketId,
    expiry: market.expiry.toString(),
    indexerStatus: "Unknown",
    onchainStatus: market.status,
    tradable: market.status === 1,
    finalized: market.finalized,
  };
}

/**
 * Autonomous position management: evaluate early-loss exits and IOC-sell losers.
 * Isolated per position. Same-cycle market ids are returned for scan exclusion.
 */

import { parseUnits, type Hex, type Address } from "viem";
import { ORDER_TYPE } from "@somnia-chain/markets-sdk";
import type { AppConfig } from "../config.ts";
import { soldCostBasis } from "./cost-basis.ts";
import { logger } from "./logger.ts";
import { getSupabaseClient } from "./supabase.ts";
import { decryptPrivateKey } from "./wallet-crypto.ts";
import { exchangeFromConfig } from "./resolved-market.ts";
import {
  evaluateEarlyExit,
  yesLimitRawForSell,
  type EarlyExitPosition,
} from "./early-exit.ts";

export type EarlyExitAttempt = {
  tradeId: string;
  marketId: string;
  symbol?: string;
  status: "exited" | "held" | "failed" | "partial";
  code?: string;
  reason: string;
  transactionHash?: string;
  proceeds?: number;
  pnl?: number;
  soldContracts?: number;
  remainingContracts?: number;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function decisionField(decision: unknown, key: string): string | number | null {
  if (!decision || typeof decision !== "object") return null;
  const value = (decision as Record<string, unknown>)[key];
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function assetLabel(position: EarlyExitPosition): string {
  const raw = (position.symbol ?? position.marketId).toUpperCase();
  const asset = raw.includes("ETH") ? "ETH" : raw.includes("BTC") ? "BTC" : raw.slice(0, 8);
  const side = String(position.direction).toLowerCase();
  const dir = side === "down" || side === "no" ? "DOWN" : "UP";
  return `${asset} ${dir}`;
}

export async function listManageablePositions(
  config: AppConfig,
  userId: string,
): Promise<EarlyExitPosition[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(
      "id, market_id, symbol, direction, status, stake_usdso, filled_contracts, limit_price, filled_at, submitted_at, decision",
    )
    .eq("user_id", userId)
    .in("status", ["filled", "partially_filled"]);
  if (error) throw new Error("Unable to list positions for early-exit.");
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const decision = r.decision;
    return {
      tradeId: String(r.id),
      marketId: String(r.market_id),
      symbol: String(r.symbol ?? ""),
      direction: String(r.direction ?? ""),
      stake: Number(r.stake_usdso ?? 0),
      filledContracts: num(r.filled_contracts),
      entryPrice: num(r.limit_price),
      filledAt: (r.filled_at as string | null) ?? null,
      submittedAt: (r.submitted_at as string | null) ?? null,
      marketExpiry: decisionField(decision, "expiry"),
      intervalSec: decisionField(decision, "intervalSec"),
      status: String(r.status),
    };
  });
}

async function markCancelled(input: {
  config: AppConfig;
  userId: string;
  tradeId: string;
  pnl: number;
  reason: string;
}): Promise<void> {
  const { error } = await getSupabaseClient(input.config)
    .from("trades")
    .update({
      status: "cancelled",
      pnl_usdso: input.pnl,
      settled_at: new Date().toISOString(),
      error_message: input.reason.slice(0, 240),
    })
    .eq("id", input.tradeId)
    .eq("user_id", input.userId)
    .in("status", ["filled", "partially_filled"]);
  if (error) throw new Error("Unable to persist early-exit close.");
}

async function reduceOpenInventory(input: {
  config: AppConfig;
  userId: string;
  tradeId: string;
  remainingContracts: number;
  remainingStake: number;
}): Promise<void> {
  const { error } = await getSupabaseClient(input.config)
    .from("trades")
    .update({
      status: "partially_filled",
      filled_contracts: input.remainingContracts,
      stake_usdso: input.remainingStake,
    })
    .eq("id", input.tradeId)
    .eq("user_id", input.userId)
    .in("status", ["filled", "partially_filled"]);
  if (error) throw new Error("Unable to persist remaining inventory after partial early-exit.");
}

function rawToHuman(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export async function manageOpenPositions(input: {
  config: AppConfig;
  userId: string;
  walletAddress: string;
  encryptedPrivateKey: string;
  liveExecutionRequested: boolean;
}): Promise<{ attempts: EarlyExitAttempt[]; excludedMarketIds: string[] }> {
  const attempts: EarlyExitAttempt[] = [];
  const excluded = new Set<string>();
  const positions = await listManageablePositions(input.config, input.userId);
  const liveEnabled =
    input.config.enableLiveExecution && input.liveExecutionRequested;
  logger.info(
    {
      userId: input.userId,
      filledPositions: positions.length,
      liveEnabled,
    },
    "early-loss inventory",
  );
  if (positions.length === 0) return { attempts, excludedMarketIds: [] };

  if (!liveEnabled) {
    return { attempts, excludedMarketIds: [] };
  }

  const privateKey = decryptPrivateKey(input.config, input.encryptedPrivateKey);
  const exchange = exchangeFromConfig(input.config);
  try {
    const trader = exchange.client.createTrader({
      privateKey: privateKey as Hex,
    });

    for (const position of positions) {
      try {
        const onchain = await exchange.client.getMarketOnchain(
          position.marketId as Hex,
        );
        if (onchain.status !== 1) {
          attempts.push({
            tradeId: position.tradeId,
            marketId: position.marketId,
            symbol: position.symbol,
            status: "held",
            code: "market_not_trading",
            reason: `On-chain status ${onchain.status} is not Trading.`,
          });
          continue;
        }
        const book = await exchange.client.getBinaryOrderBook(onchain.pool as Address, {
          depth: 5,
          decimals: onchain.decimals,
        });
        const levels = position.direction === "down" ? book.noBids : book.yesBids;
        const top = levels[0];
        const bid = top ? rawToHuman(top.price, onchain.decimals) : null;
        const decision = evaluateEarlyExit({ position, currentBid: bid });
        logger.info(
          {
            tradeId: position.tradeId,
            marketId: position.marketId,
            action: decision.action,
            bid,
            code: decision.action === "hold" ? decision.code : "exit",
          },
          "early-loss evaluation",
        );
        if (decision.action === "hold") {
          attempts.push({
            tradeId: position.tradeId,
            marketId: position.marketId,
            symbol: position.symbol,
            status: "held",
            code: decision.code,
            reason: decision.reason,
          });
          continue;
        }

        const contracts = position.filledContracts ?? 0;
        const quantity = parseUnits(String(contracts), onchain.decimals);
        const price = yesLimitRawForSell({
          direction: position.direction,
          outcomeOwnBid: bid!,
          decimals: onchain.decimals,
        });
        if (!price || quantity <= 0n) {
          attempts.push({
            tradeId: position.tradeId,
            marketId: position.marketId,
            symbol: position.symbol,
            status: "held",
            code: "invalid_sell",
            reason: "Could not encode a valid SELL price/size.",
          });
          continue;
        }

        const result = await trader.placeOrder({
          pool: onchain.pool as Address,
          side: position.direction === "down" ? "SELL_NO" : "SELL_YES",
          price,
          quantity,
          orderType: ORDER_TYPE.MARKET,
          expireTimestampNs: BigInt(Math.floor(Date.now() / 1000) + 90) * 1_000_000_000n,
          autoApprove: true,
        });
        const filled = result.fills.reduce(
          (total, fill) => total + rawToHuman(fill.quantityFilled, onchain.decimals),
          0,
        );
        if (filled <= 0) {
          attempts.push({
            tradeId: position.tradeId,
            marketId: position.marketId,
            symbol: position.symbol,
            status: "failed",
            code: "ioc_no_fill",
            reason: "Early-exit sell did not fill. Position left open.",
            transactionHash: result.hash,
          });
          continue;
        }

        const proceeds = result.fills.reduce((total, fill) => {
          const qty = rawToHuman(fill.quantityFilled, onchain.decimals);
          const yesPrice = rawToHuman(fill.fillPrice, onchain.decimals);
          const own = position.direction === "down" ? 1 - yesPrice : yesPrice;
          return total + qty * own;
        }, 0);
        const costSold = soldCostBasis({
          positionStake: position.stake,
          positionContracts: contracts,
          soldContracts: filled,
        });
        const pnl = Math.round((proceeds - costSold) * 1e6) / 1e6;
        const remaining = Math.max(0, contracts - filled);
        const remainingStake = Math.round((position.stake - costSold) * 1e6) / 1e6;

        if (remaining > 1e-6) {
          await reduceOpenInventory({
            config: input.config,
            userId: input.userId,
            tradeId: position.tradeId,
            remainingContracts: remaining,
            remainingStake: Math.max(0, remainingStake),
          });
          logger.info(
            {
              tradeId: position.tradeId,
              sold: filled,
              remaining,
              proceeds,
              pnl,
            },
            "early-loss partial sell kept remainder",
          );
          excluded.add(position.marketId);
          attempts.push({
            tradeId: position.tradeId,
            marketId: position.marketId,
            symbol: position.symbol,
            status: "partial",
            reason: "Partial early-exit sell; remainder stays open.",
            transactionHash: result.hash,
            proceeds,
            pnl,
            soldContracts: filled,
            remainingContracts: remaining,
          });
          continue;
        }

        await markCancelled({
          config: input.config,
          userId: input.userId,
          tradeId: position.tradeId,
          pnl,
          reason: `${decision.reason} sellTx=${result.hash}`,
        });
        excluded.add(position.marketId);
        attempts.push({
          tradeId: position.tradeId,
          marketId: position.marketId,
          symbol: position.symbol,
          status: "exited",
          reason: decision.reason,
          transactionHash: result.hash,
          proceeds,
          pnl,
          soldContracts: filled,
          remainingContracts: 0,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 200) : "Early-exit failed.";
        logger.warn(
          { tradeId: position.tradeId, marketId: position.marketId, err: message },
          "early-loss exit failed",
        );
        attempts.push({
          tradeId: position.tradeId,
          marketId: position.marketId,
          symbol: position.symbol,
          status: "failed",
          code: "exit_error",
          reason: message,
        });
      }
    }
  } finally {
    await Promise.race([
      exchange.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  return { attempts, excludedMarketIds: [...excluded] };
}

export function formatEarlyExitMessage(attempts: EarlyExitAttempt[]): string | null {
  const notable = attempts.filter((a) => a.status !== "held");
  if (notable.length === 0) return null;
  return [
    "Position management",
    "",
    ...notable.map((a) => {
      const title = assetLabel({
        tradeId: a.tradeId,
        marketId: a.marketId,
        symbol: a.symbol,
        direction: a.symbol?.toLowerCase().includes("down") ? "down" : "up",
        stake: 0,
        filledContracts: null,
        entryPrice: null,
        filledAt: null,
        submittedAt: null,
        marketExpiry: null,
        status: "filled",
      } as EarlyExitPosition);
      if (a.status === "failed") {
        return `${title} stay open\nNothing was taken at this price.`;
      }
      const proceeds =
        a.proceeds !== undefined && Number.isFinite(a.proceeds)
          ? `\nProceeds: ${Math.round(a.proceeds * 1e4) / 1e4} tUSDC`
          : "";
      const pnl =
        a.pnl !== undefined && Number.isFinite(a.pnl)
          ? `\nPnL: ${a.pnl > 0 ? "+" : ""}${Math.round(a.pnl * 1e4) / 1e4} tUSDC`
          : "";
      const remain =
        a.status === "partial" && a.remainingContracts
          ? `\nRemainder still open: ${Math.round(a.remainingContracts * 1e3) / 1e3}`
          : "";
      return `${title} closed early${proceeds}${pnl}${remain}`;
    }),
  ].join("\n");
}

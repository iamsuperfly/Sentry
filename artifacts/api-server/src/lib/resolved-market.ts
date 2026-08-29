/**
 * On-chain / finalized market lookup — not the live list.
 */

import {
  SOMNIA_TESTNET_ADDRESSES,
  SomniaMarkets,
  type MarketOnchain,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import type { Address, Hex } from "viem";
import type { AppConfig } from "../config.ts";
import type { MarketLifecycleView } from "./position-lifecycle.ts";
import type { DreamdexBook } from "./dreamdex.ts";

export function exchangeFromConfig(config: AppConfig): SomniaMarkets {
  return new SomniaMarkets({
    chain: somniaShannon,
    wsRpcUrl: config.wsRpcUrl,
    indexerUrl: config.dreamdexIndexerUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });
}

export function onchainToLifecycle(
  marketId: string,
  onchain: MarketOnchain,
): MarketLifecycleView {
  let winningOutcome: number | null = null;
  if (onchain.isResolved) {
    const n = Number(onchain.winningOutcome);
    winningOutcome = Number.isFinite(n) ? n : null;
  }
  return {
    marketId,
    expiry: onchain.expiry?.toString?.() ?? String(onchain.expiry ?? ""),
    finalized: onchain.finalized,
    onchainStatus: onchain.status,
    tradable: onchain.status === 1,
    isResolved: onchain.isResolved,
    isVoided: onchain.isVoided,
    winningOutcome,
  };
}

export async function readResolvedMarketOnchain(
  config: AppConfig,
  marketId: string,
): Promise<MarketLifecycleView | null> {
  const exchange = exchangeFromConfig(config);
  try {
    const onchain = await exchange.client.getMarketOnchain(marketId as Hex);
    return onchainToLifecycle(marketId, onchain);
  } catch {
    return null;
  } finally {
    await Promise.race([
      exchange.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

export async function readFreshBinaryBook(
  config: AppConfig,
  poolAddress: string,
  decimals: number,
): Promise<DreamdexBook> {
  const exchange = exchangeFromConfig(config);
  try {
    const book = await exchange.client.getBinaryOrderBook(poolAddress as Address, {
      depth: 5,
      decimals,
    });
    const levels = (entries: Array<{ price: bigint; quantity: bigint }>) =>
      entries.map(({ price, quantity }) => ({
        price: price.toString(),
        quantity: quantity.toString(),
      }));
    return {
      yesBids: levels(book.yesBids),
      yesAsks: levels(book.yesAsks),
      noBids: levels(book.noBids),
      noAsks: levels(book.noAsks),
    };
  } finally {
    await Promise.race([
      exchange.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

export function rawToHuman(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

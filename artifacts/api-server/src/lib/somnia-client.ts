/**
 * Process-level Somnia/DreamDEX client lifecycle.
 *
 * Reads + live tail share one SomniaMarkets (one WebSocket). Writes never use
 * that instance: each user submit gets its own exchange+trader bound to that
 * user's key, then closed. User A must never inherit User B's signer.
 */

import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SomniaMarkets,
  type Trader,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import type { AppConfig } from "../config.ts";
import { closeExchange } from "./exchange-lifecycle.ts";
import { logger } from "./logger.ts";

let shared: SomniaMarkets | null = null;
let sharedKey = "";

function exchangeConfig(config: AppConfig) {
  return {
    chain: somniaShannon,
    wsRpcUrl: config.wsRpcUrl,
    indexerUrl: config.dreamdexIndexerUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  };
}

function connectionKey(config: AppConfig): string {
  return `${config.wsRpcUrl}|${config.dreamdexIndexerUrl}`;
}

/** Long-lived read/watch client. Never pass a user private key. Never close after a listing. */
export function getSharedSomniaExchange(config: AppConfig): SomniaMarkets {
  const key = connectionKey(config);
  if (shared && sharedKey === key) return shared;
  if (shared) {
    const previous = shared;
    shared = null;
    void closeExchange(previous, { chainTouched: true });
  }
  shared = new SomniaMarkets(exchangeConfig(config));
  sharedKey = key;
  logger.info({ wsRpcUrl: config.wsRpcUrl }, "shared SomniaMarkets read client created");
  return shared;
}

export type UserWriteSession = {
  trader: Trader;
  account: ReturnType<typeof privateKeyToAccount>;
  address: Address;
  exchange: SomniaMarkets;
};

/**
 * One write client per user action. Closed in `finally` so sockets cannot leak
 * across Telegram users. The shared read client is never used for signing.
 */
export async function withUserWriteSession<T>(
  config: AppConfig,
  privateKey: string,
  fn: (session: UserWriteSession) => Promise<T>,
): Promise<T> {
  const hex = privateKey as Hex;
  const account = privateKeyToAccount(hex);
  const exchange = new SomniaMarkets({
    ...exchangeConfig(config),
    privateKey: hex,
  });
  try {
    const trader = exchange.client.createTrader({ privateKey: hex });
    return await fn({
      trader,
      account,
      address: account.address,
      exchange,
    });
  } finally {
    await closeExchange(exchange, { chainTouched: true });
  }
}

export function signerAddressFromPrivateKey(privateKey: string): Address {
  return privateKeyToAccount(privateKey as Hex).address;
}

export async function resetSharedSomniaExchange(): Promise<void> {
  if (!shared) return;
  const previous = shared;
  shared = null;
  sharedKey = "";
  await closeExchange(previous, { chainTouched: true });
}

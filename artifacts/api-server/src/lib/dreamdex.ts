import {
  SOMNIA_TESTNET_ADDRESSES,
  SomniaMarkets,
  type BinaryMarket,
  type BinaryOrderBook,
  type MarketOnchain,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import type { Hex } from "viem";
import type { AppConfig } from "../config";

const SHANNON_CHAIN_ID = 50312;
const ONCHAIN_TRADING_STATUS = 1;
const MARKET_LIMIT = 100;
const BOOK_DEPTH = 5;
const SUPPORTED_ASSETS = new Set(["BTC", "ETH"]);

type SerializableLevel = {
  price: string;
  quantity: string;
};

export type DreamdexBook = {
  yesBids: SerializableLevel[];
  yesAsks: SerializableLevel[];
  noBids: SerializableLevel[];
  noAsks: SerializableLevel[];
};

export type DreamdexMarketDiagnostic = {
  marketId: string;
  marketAddress: string;
  poolAddress: string;
  poolNonce: string;
  asset: string;
  question: string;
  oracleQuestion: string | null;
  strike: string;
  /** Indexer BinaryMarket.tradingStart (unix seconds string). */
  tradingStart: string;
  /** Indexer BinaryMarket.expiry (unix seconds string). */
  expiry: string;
  /** SDK-derived interval when present (seconds string). */
  intervalSec: string | null;
  indexerStatus: BinaryMarket["status"];
  onchainStatus: number;
  tradable: boolean;
  finalized: boolean;
  /** On-chain: oracle resolved to a concrete winner. */
  isResolved: boolean;
  /** On-chain: voided (0.5 redeem both sides). */
  isVoided: boolean;
  /**
   * Winning outcome: 0 = YES, 1 = NO.
   * Prefer on-chain when isResolved; else indexer BinaryMarket.winningOutcome.
   * null when not yet known — never invent.
   */
  winningOutcome: number | null;
  collateral: string;
  decimals: number;
  book: DreamdexBook;
};

export type DreamdexDiagnostic = {
  network: {
    name: string;
    chainId: number;
    rpcUrl: string;
    indexerUrl: string;
  };
  markets: DreamdexMarketDiagnostic[];
  discoveredCount: number;
  supportedCount: number;
  tradableCount: number;
  listingApi?: string;
};

function serializeBook(book: BinaryOrderBook): DreamdexBook {
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
}

function serializeMarket(
  market: BinaryMarket,
  onchain: MarketOnchain,
  book: BinaryOrderBook,
): DreamdexMarketDiagnostic {
  const intervalSec =
    market.intervalSec !== undefined && market.intervalSec !== null
      ? String(market.intervalSec)
      : null;

  // Prefer explicit on-chain resolution flags; fall back to indexer winningOutcome.
  let winningOutcome: number | null = null;
  if (onchain.isResolved) {
    winningOutcome = Number(onchain.winningOutcome);
  } else if (
    market.winningOutcome !== null &&
    market.winningOutcome !== undefined &&
    Number.isFinite(Number(market.winningOutcome))
  ) {
    winningOutcome = Number(market.winningOutcome);
  }

  return {
    marketId: market.marketId,
    marketAddress: market.marketAddress,
    poolAddress: onchain.pool,
    poolNonce: onchain.nonce.toString(),
    asset: market.asset,
    question: market.question,
    oracleQuestion: market.oracleQuestion,
    strike: market.strike,
    tradingStart: market.tradingStart,
    expiry: market.expiry,
    intervalSec,
    indexerStatus: market.status,
    onchainStatus: onchain.status,
    tradable:
      market.status === "Trading" &&
      onchain.status === ONCHAIN_TRADING_STATUS,
    finalized: onchain.finalized,
    isResolved: onchain.isResolved,
    isVoided: onchain.isVoided,
    winningOutcome,
    collateral: onchain.collateral,
    decimals: onchain.decimals,
    book: serializeBook(book),
  };
}

export async function readDreamdexMarkets(
  config: AppConfig,
  asset?: string,
): Promise<DreamdexDiagnostic> {
  const exchange = new SomniaMarkets({
    indexerUrl: config.dreamdexIndexerUrl,
    chain: somniaShannon,
    wsRpcUrl: config.wsRpcUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });

  try {
    const requestedAsset = asset?.trim().toUpperCase();
    const listOpts = {
      asset: requestedAsset && SUPPORTED_ASSETS.has(requestedAsset)
        ? requestedAsset
        : undefined,
      limit: MARKET_LIMIT,
    };
    // Prefer live listing when available (SDK 0.28.1); fall back to general binary list.
    let listingApi = "listBinaryMarkets";
    let markets: Awaited<
      ReturnType<typeof exchange.client.listBinaryMarkets>
    >;
    const liveFn = (
      exchange.client as {
        listLiveBinaryMarkets?: (opts: typeof listOpts) => Promise<
          Awaited<ReturnType<typeof exchange.client.listBinaryMarkets>>
        >;
      }
    ).listLiveBinaryMarkets;
    if (typeof liveFn === "function") {
      try {
        markets = await liveFn.call(exchange.client, listOpts);
        listingApi = "listLiveBinaryMarkets";
      } catch {
        markets = await exchange.client.listBinaryMarkets(listOpts);
        listingApi = "listBinaryMarkets";
      }
    } else {
      markets = await exchange.client.listBinaryMarkets(listOpts);
    }
    const supportedMarkets = markets.filter((market) =>
      SUPPORTED_ASSETS.has(market.asset.toUpperCase()),
    );
    const selectedMarkets = requestedAsset
      ? supportedMarkets.filter(
          (market) => market.asset.toUpperCase() === requestedAsset,
        )
      : supportedMarkets;

    const diagnostics = await Promise.all(
      selectedMarkets.map(async (market) => {
        const onchain = await exchange.client.getMarketOnchain(
          market.marketId as Hex,
        );
        const book = await exchange.client.getBinaryOrderBook(onchain.pool, {
          depth: BOOK_DEPTH,
          decimals: onchain.decimals,
        });
        return serializeMarket(market, onchain, book);
      }),
    );

    return {
      network: {
        name: somniaShannon.name,
        chainId: SHANNON_CHAIN_ID,
        rpcUrl: config.rpcUrl,
        indexerUrl: config.dreamdexIndexerUrl,
      },
      markets: diagnostics,
      discoveredCount: markets.length,
      supportedCount: selectedMarkets.length,
      tradableCount: diagnostics.filter((market) => market.tradable).length,
      listingApi,
    };
  } finally {
    await Promise.race([
      exchange.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

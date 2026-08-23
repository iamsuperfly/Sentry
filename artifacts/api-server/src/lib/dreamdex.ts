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
  tradingStart: string;
  expiry: string;
  indexerStatus: BinaryMarket["status"];
  onchainStatus: number;
  tradable: boolean;
  finalized: boolean;
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
    indexerStatus: market.status,
    onchainStatus: onchain.status,
    tradable:
      market.status === "Trading" &&
      onchain.status === ONCHAIN_TRADING_STATUS,
    finalized: onchain.finalized,
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
    const markets = await exchange.client.listBinaryMarkets({
      asset: requestedAsset && SUPPORTED_ASSETS.has(requestedAsset)
        ? requestedAsset
        : undefined,
      limit: MARKET_LIMIT,
    });
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
    };
  } finally {
    await Promise.race([
      exchange.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}
/**
 * Stage 2 strategy layer — pure evaluation over Stage 1 market diagnostics.
 * No keys, no orders, no persistence.
 */

export const STRATEGY_NAME = "edge-taker-v1";
export const STRATEGY_VERSION = "1.0.0";

/** Fair probability prior for binary up/down when no external signal exists. */
export const FAIR_PROBABILITY = 0.5;

/**
 * Minimum edge (fair - ask) required to enter as a taker.
 * 0.08 means we only buy when ask is at most 0.42 given fair=0.5.
 */
export const DEFAULT_EDGE_THRESHOLD = 0.08;

/** Skip markets with less than this many seconds until expiry. */
export const DEFAULT_MIN_SECONDS_TO_EXPIRY = 300;

/** Skip if top-of-book spread is wider than this (probability points). */
export const DEFAULT_MAX_SPREAD = 0.1;

export type StrategyConfig = {
  edgeThreshold: number;
  minSecondsToExpiry: number;
  maxSpread: number;
};

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  edgeThreshold: DEFAULT_EDGE_THRESHOLD,
  minSecondsToExpiry: DEFAULT_MIN_SECONDS_TO_EXPIRY,
  maxSpread: DEFAULT_MAX_SPREAD,
};

export type TradeDirection = "YES" | "NO";

export type StrategyAction = "enter" | "skip";

export type BookTop = {
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
};

export type StrategyDecision = {
  strategyName: string;
  strategyVersion: string;
  action: StrategyAction;
  marketId: string;
  asset: string;
  marketAddress: string;
  poolAddress: string;
  poolNonce: string;
  expiry: string;
  direction: TradeDirection | null;
  /** Suggested limit probability for a future IOC taker (human 0–1). */
  limitPriceHint: number | null;
  edge: number | null;
  edgeThreshold: number;
  fairProbability: number;
  book: BookTop;
  secondsToExpiry: number | null;
  tradable: boolean;
  finalized: boolean;
  indexerStatus: string;
  onchainStatus: number;
  reason: string;
  skipCode: string | null;
};

export type StrategyRunResult = {
  strategyName: typeof STRATEGY_NAME;
  strategyVersion: typeof STRATEGY_VERSION;
  evaluatedAt: string;
  config: {
    edgeThreshold: number;
    minSecondsToExpiry: number;
    maxSpread: number;
    supportedAssets: string[];
  };
  decisions: StrategyDecision[];
  enterCount: number;
  skipCount: number;
};

import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";

const SUPPORTED = new Set(["BTC", "ETH"]);

function levelPrice(
  levels: Array<{ price: string; quantity: string }> | undefined,
  decimals: number,
): number | null {
  const raw = levels?.[0]?.price;
  if (raw === undefined) return null;
  const scale = 10 ** decimals;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const value = Number(raw) / scale;
  return Number.isFinite(value) ? value : null;
}

export function extractBookTop(
  market: DreamdexMarketDiagnostic,
): BookTop {
  const d = market.decimals;
  return {
    yesBid: levelPrice(market.book.yesBids, d),
    yesAsk: levelPrice(market.book.yesAsks, d),
    noBid: levelPrice(market.book.noBids, d),
    noAsk: levelPrice(market.book.noAsks, d),
  };
}

export function secondsToExpiry(
  expiry: string,
  nowSeconds: number,
): number | null {
  const exp = Number(expiry);
  if (!Number.isFinite(exp)) return null;
  const expSec = exp >= 1e12 ? exp / 1000 : exp;
  return expSec - nowSeconds;
}

function skip(
  market: DreamdexMarketDiagnostic,
  book: BookTop,
  secondsLeft: number | null,
  code: string,
  reason: string,
  extra: Partial<StrategyDecision> = {},
): StrategyDecision {
  return {
    strategyName: STRATEGY_NAME,
    strategyVersion: STRATEGY_VERSION,
    action: "skip",
    marketId: market.marketId,
    asset: market.asset,
    marketAddress: market.marketAddress,
    poolAddress: market.poolAddress,
    poolNonce: market.poolNonce,
    expiry: market.expiry,
    direction: null,
    limitPriceHint: null,
    edge: null,
    edgeThreshold: DEFAULT_EDGE_THRESHOLD,
    fairProbability: FAIR_PROBABILITY,
    book,
    secondsToExpiry: secondsLeft,
    tradable: market.tradable,
    finalized: market.finalized,
    indexerStatus: String(market.indexerStatus),
    onchainStatus: market.onchainStatus,
    reason,
    skipCode: code,
    ...extra,
  };
}

export function evaluateMarket(
  market: DreamdexMarketDiagnostic,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyDecision {
  const book = extractBookTop(market);
  const secondsLeft = secondsToExpiry(market.expiry, nowSeconds);

  if (!SUPPORTED.has(market.asset.toUpperCase())) {
    return skip(market, book, secondsLeft, "unsupported_asset", `Asset ${market.asset} is not supported.`);
  }
  if (!market.tradable || market.finalized) {
    return skip(market, book, secondsLeft, "not_tradable", "Market is not tradable or already finalized.");
  }
  if (secondsLeft === null) {
    return skip(market, book, secondsLeft, "bad_expiry", "Could not parse market expiry.");
  }
  if (secondsLeft < config.minSecondsToExpiry) {
    return skip(
      market,
      book,
      secondsLeft,
      "too_close_to_expiry",
      `Only ${Math.floor(secondsLeft)}s left; require at least ${config.minSecondsToExpiry}s headroom.`,
    );
  }

  const yesAsk = book.yesAsk;
  const noAsk = book.noAsk;
  const yesBid = book.yesBid;
  const noBid = book.noBid;

  // Prefer the cheaper side relative to fair 0.5.
  const candidates: Array<{ direction: TradeDirection; ask: number; edge: number }> = [];
  if (yesAsk !== null) {
    candidates.push({
      direction: "YES",
      ask: yesAsk,
      edge: FAIR_PROBABILITY - yesAsk,
    });
  }
  if (noAsk !== null) {
    candidates.push({
      direction: "NO",
      ask: noAsk,
      edge: FAIR_PROBABILITY - noAsk,
    });
  }
  if (candidates.length === 0) {
    return skip(market, book, secondsLeft, "empty_book", "No asks on YES or NO.");
  }

  candidates.sort((a, b) => b.edge - a.edge);
  const best = candidates[0]!;

  if (best.edge < config.edgeThreshold) {
    return skip(
      market,
      book,
      secondsLeft,
      "insufficient_edge",
      `Best edge ${best.edge.toFixed(4)} below threshold ${config.edgeThreshold}.`,
      {
        direction: best.direction,
        limitPriceHint: best.ask,
        edge: best.edge,
        edgeThreshold: config.edgeThreshold,
      },
    );
  }

  // Optional spread guard on the chosen side.
  const bid = best.direction === "YES" ? yesBid : noBid;
  if (bid !== null) {
    const spread = best.ask - bid;
    if (spread > config.maxSpread) {
      return skip(
        market,
        book,
        secondsLeft,
        "spread_too_wide",
        `Spread ${spread.toFixed(4)} exceeds max ${config.maxSpread}.`,
        {
          direction: best.direction,
          limitPriceHint: best.ask,
          edge: best.edge,
          edgeThreshold: config.edgeThreshold,
        },
      );
    }
  }

  return {
    strategyName: STRATEGY_NAME,
    strategyVersion: STRATEGY_VERSION,
    action: "enter",
    marketId: market.marketId,
    asset: market.asset,
    marketAddress: market.marketAddress,
    poolAddress: market.poolAddress,
    poolNonce: market.poolNonce,
    expiry: market.expiry,
    direction: best.direction,
    limitPriceHint: best.ask,
    edge: best.edge,
    edgeThreshold: config.edgeThreshold,
    fairProbability: FAIR_PROBABILITY,
    book,
    secondsToExpiry: secondsLeft,
    tradable: market.tradable,
    finalized: market.finalized,
    indexerStatus: String(market.indexerStatus),
    onchainStatus: market.onchainStatus,
    reason: `Edge ${best.edge.toFixed(4)} on ${best.direction} at ask ${best.ask}.`,
    skipCode: null,
  };
}

export function evaluateMarkets(
  markets: DreamdexMarketDiagnostic[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyRunResult {
  const decisions = markets.map((m) => evaluateMarket(m, nowSeconds, config));
  // Sort enters by edge descending for stable selection.
  const enters = decisions
    .filter((d) => d.action === "enter")
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0));
  const skips = decisions.filter((d) => d.action === "skip");
  const ordered = [...enters, ...skips];
  return {
    strategyName: STRATEGY_NAME,
    strategyVersion: STRATEGY_VERSION,
    evaluatedAt: new Date(nowSeconds * 1000).toISOString(),
    config: {
      edgeThreshold: config.edgeThreshold,
      minSecondsToExpiry: config.minSecondsToExpiry,
      maxSpread: config.maxSpread,
      supportedAssets: ["BTC", "ETH"],
    },
    decisions: ordered,
    enterCount: enters.length,
    skipCount: skips.length,
  };
}

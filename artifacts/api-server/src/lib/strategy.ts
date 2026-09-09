/**
 * Stage 2 strategy layer — deterministic edge-taker-v1 (restored from 3050803).
 * No keys, no orders, no persistence. 1m markets are skipped; they use the Binance vote engine.
 */

import type { DreamdexMarketDiagnostic } from "./dreamdex.ts";
import { classifyMarketDuration } from "./market-duration.ts";

export const STRATEGY_NAME = "edge-taker-v1";
export const STRATEGY_VERSION = "1.0.0";

/** Fair probability prior for binary up/down when no external signal exists. */
export const FAIR_PROBABILITY = 0.5;

/**
 * Minimum distance from fair before entering.
 * Enter YES when yesAsk <= FAIR - EDGE (default 0.42).
 * Enter NO when noAsk <= 0.42, else when yesAsk >= FAIR + EDGE (default 0.58).
 */
export const DEFAULT_EDGE_THRESHOLD = 0.08;

/** 15m+ headroom (DreamDEX recipe guidance). Not applied to 5m. */
export const DEFAULT_MIN_SECONDS_TO_EXPIRY = 300;

/** 5m markets require at least this many seconds remaining. */
export const FIVE_MIN_MIN_SECONDS_TO_EXPIRY = 120;

/** Skip when YES top-of-book spread is wider than this (when both bid and ask exist). */
export const DEFAULT_MAX_SPREAD = 0.1;

export type StrategyConfig = {
  edgeThreshold: number;
  minSecondsToExpiry: number;
  maxSpread: number;
  supportedAssets: ReadonlySet<string>;
};

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  edgeThreshold: DEFAULT_EDGE_THRESHOLD,
  minSecondsToExpiry: DEFAULT_MIN_SECONDS_TO_EXPIRY,
  maxSpread: DEFAULT_MAX_SPREAD,
  supportedAssets: new Set(["BTC", "ETH"]),
};

export type TradeDirection = "YES" | "NO";

export type StrategyAction = "enter" | "skip";

export type BookTop = {
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  yesSpread: number | null;
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
  strategyName: string;
  strategyVersion: string;
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
  const yesBid = levelPrice(market.book.yesBids, d);
  const yesAsk = levelPrice(market.book.yesAsks, d);
  const noBid = levelPrice(market.book.noBids, d);
  const noAsk = levelPrice(market.book.noAsks, d);
  const yesSpread =
    yesBid !== null && yesAsk !== null ? yesAsk - yesBid : null;
  return { yesBid, yesAsk, noBid, noAsk, yesSpread };
}

export function secondsToExpiry(
  expiry: string,
  nowSeconds: number,
): number | null {
  const expiryNum = Number(expiry);
  if (!Number.isFinite(expiryNum)) return null;
  const expirySec = expiryNum >= 1e12 ? expiryNum / 1000 : expiryNum;
  return expirySec - nowSeconds;
}

export function minSecondsToExpiryForMarket(
  market: Pick<
    DreamdexMarketDiagnostic,
    "intervalSec" | "tradingStart" | "expiry"
  >,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): { bucket: string; minSeconds: number | null } {
  const { bucket } = classifyMarketDuration({
    intervalSec: market.intervalSec,
    tradingStart: market.tradingStart,
    expiry: market.expiry,
  });
  if (bucket === "1m") return { bucket, minSeconds: null };
  if (bucket === "5m") return { bucket, minSeconds: FIVE_MIN_MIN_SECONDS_TO_EXPIRY };
  return { bucket, minSeconds: config.minSecondsToExpiry };
}

function skip(
  market: DreamdexMarketDiagnostic,
  book: BookTop,
  config: StrategyConfig,
  secondsLeft: number | null,
  skipCode: string,
  reason: string,
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
    edgeThreshold: config.edgeThreshold,
    fairProbability: FAIR_PROBABILITY,
    book,
    secondsToExpiry: secondsLeft,
    tradable: market.tradable,
    finalized: market.finalized,
    indexerStatus: String(market.indexerStatus),
    onchainStatus: market.onchainStatus,
    reason,
    skipCode,
  };
}

function enter(
  market: DreamdexMarketDiagnostic,
  book: BookTop,
  config: StrategyConfig,
  secondsLeft: number,
  direction: TradeDirection,
  limitPriceHint: number,
  edge: number,
  reason: string,
): StrategyDecision {
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
    direction,
    limitPriceHint,
    edge,
    edgeThreshold: config.edgeThreshold,
    fairProbability: FAIR_PROBABILITY,
    book,
    secondsToExpiry: secondsLeft,
    tradable: market.tradable,
    finalized: market.finalized,
    indexerStatus: String(market.indexerStatus),
    onchainStatus: market.onchainStatus,
    reason,
    skipCode: null,
  };
}

/**
 * Evaluate one market diagnostic.
 * Deterministic pure function — 1m is not handled here.
 */
export function evaluateMarket(
  market: DreamdexMarketDiagnostic,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyDecision {
  const book = extractBookTop(market);
  const secondsLeft = secondsToExpiry(market.expiry, nowSeconds);
  const asset = market.asset.toUpperCase();

  if (!config.supportedAssets.has(asset)) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "unsupported_asset",
      `Asset ${market.asset} is outside the supported set (BTC, ETH).`,
    );
  }

  if (market.finalized || market.indexerStatus === "Finalized") {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "finalized",
      "Market is finalized; strategy only evaluates open trading windows.",
    );
  }

  if (!market.tradable || market.onchainStatus !== 1) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "not_tradable",
      `Market is not tradable (indexer=${market.indexerStatus}, onchainStatus=${market.onchainStatus}).`,
    );
  }

  if (secondsLeft === null) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "bad_expiry",
      "Could not parse market expiry.",
    );
  }

  if (secondsLeft <= 0) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "expired",
      "Market expiry is in the past.",
    );
  }

  const timing = minSecondsToExpiryForMarket(market, config);
  if (timing.bucket === "1m" || timing.minSeconds === null) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "one_min_market",
      "1m markets use the Binance vote engine, not edge-taker-v1.",
    );
  }

  if (secondsLeft < timing.minSeconds) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "near_expiry",
      `Only ${Math.floor(secondsLeft)}s left; require at least ${timing.minSeconds}s headroom (${timing.bucket}).`,
    );
  }

  if (book.yesAsk === null && book.noAsk === null) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "no_liquidity",
      "No resting asks on YES or NO; cannot size a taker entry.",
    );
  }

  if (book.yesSpread !== null && book.yesSpread > config.maxSpread) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "wide_spread",
      `YES top-of-book spread ${book.yesSpread.toFixed(4)} exceeds max ${config.maxSpread}.`,
    );
  }

  const enterYesCeiling = FAIR_PROBABILITY - config.edgeThreshold;
  const enterNoFloor = FAIR_PROBABILITY + config.edgeThreshold;

  if (book.yesAsk !== null && book.yesAsk <= enterYesCeiling) {
    const edge = FAIR_PROBABILITY - book.yesAsk;
    return enter(
      market,
      book,
      config,
      secondsLeft,
      "YES",
      book.yesAsk,
      edge,
      `YES ask ${book.yesAsk.toFixed(4)} is at least ${config.edgeThreshold} below fair ${FAIR_PROBABILITY} (edge ${edge.toFixed(4)}).`,
    );
  }

  if (book.noAsk !== null && book.noAsk <= enterYesCeiling) {
    const edge = FAIR_PROBABILITY - book.noAsk;
    return enter(
      market,
      book,
      config,
      secondsLeft,
      "NO",
      book.noAsk,
      edge,
      `NO ask ${book.noAsk.toFixed(4)} is at least ${config.edgeThreshold} below fair ${FAIR_PROBABILITY} (edge ${edge.toFixed(4)}).`,
    );
  }

  if (book.yesAsk !== null && book.yesAsk >= enterNoFloor) {
    const edge = book.yesAsk - FAIR_PROBABILITY;
    const impliedNo = 1 - book.yesAsk;
    return enter(
      market,
      book,
      config,
      secondsLeft,
      "NO",
      book.noAsk ?? Math.max(impliedNo, 0),
      edge,
      `YES ask ${book.yesAsk.toFixed(4)} is at least ${config.edgeThreshold} above fair; prefer NO (implied ~${impliedNo.toFixed(4)}).`,
    );
  }

  return skip(
    market,
    book,
    config,
    secondsLeft,
    "no_edge",
    `Top-of-book does not clear edge threshold ${config.edgeThreshold} vs fair ${FAIR_PROBABILITY} (yesAsk=${book.yesAsk ?? "n/a"}, noAsk=${book.noAsk ?? "n/a"}).`,
  );
}

function compareEnterRank(a: StrategyDecision, b: StrategyDecision): number {
  const leftA = a.secondsToExpiry ?? Number.POSITIVE_INFINITY;
  const leftB = b.secondsToExpiry ?? Number.POSITIVE_INFINITY;
  if (leftA !== leftB) return leftA - leftB;
  return a.marketId.localeCompare(b.marketId);
}

/** Evaluate many markets; enters sorted by least time remaining, then marketId. */
export function evaluateMarkets(
  markets: DreamdexMarketDiagnostic[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyRunResult {
  const decisions = markets.map((market) =>
    evaluateMarket(market, nowSeconds, config),
  );

  const enters = decisions
    .filter((d) => d.action === "enter")
    .sort(compareEnterRank);
  const skips = decisions.filter((d) => d.action === "skip");

  return {
    strategyName: STRATEGY_NAME,
    strategyVersion: STRATEGY_VERSION,
    evaluatedAt: new Date(nowSeconds * 1000).toISOString(),
    config: {
      edgeThreshold: config.edgeThreshold,
      minSecondsToExpiry: config.minSecondsToExpiry,
      maxSpread: config.maxSpread,
      supportedAssets: [...config.supportedAssets],
    },
    decisions: [...enters, ...skips],
    enterCount: enters.length,
    skipCount: skips.length,
  };
}

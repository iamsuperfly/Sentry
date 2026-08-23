import type { DreamdexMarketDiagnostic } from "./dreamdex";

/** Pure Stage 2 strategy — no network, keys, or execution. */

export const STRATEGY_NAME = "edge-taker-v1";
export const STRATEGY_VERSION = "1.0.0";

/** Fair probability for a short Up/Down window before edge. */
export const FAIR_PROBABILITY = 0.5;

/**
 * Minimum distance from fair before entering.
 * Enter YES when yesAsk <= FAIR - EDGE (default 0.42).
 * Enter NO when yesAsk >= FAIR + EDGE (default 0.58),
 * equivalently when implied NO is cheap.
 */
export const DEFAULT_EDGE_THRESHOLD = 0.08;

/** Skip windows with less than this many seconds left (DreamDEX recipe guidance). */
export const DEFAULT_MIN_SECONDS_TO_EXPIRY = 300;

/** Skip when top-of-book spread is wider than this (when both bid and ask exist). */
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
  strategyName: typeof STRATEGY_NAME;
  strategyVersion: typeof STRATEGY_VERSION;
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
  // Accept seconds or milliseconds.
  const expirySec = expiryNum > 1e12 ? expiryNum / 1000 : expiryNum;
  return expirySec - nowSeconds;
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
    indexerStatus: market.indexerStatus,
    onchainStatus: market.onchainStatus,
    reason,
    skipCode,
  };
}

/**
 * Evaluate one market diagnostic from Stage 1.
 * Deterministic pure function — safe to unit test without network.
 */
export function evaluateMarket(
  market: DreamdexMarketDiagnostic,
  nowSeconds: number = Date.now() / 1000,
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

  if (secondsLeft < config.minSecondsToExpiry) {
    return skip(
      market,
      book,
      config,
      secondsLeft,
      "near_expiry",
      `Only ${Math.floor(secondsLeft)}s left; require at least ${config.minSecondsToExpiry}s headroom.`,
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

  if (
    book.yesSpread !== null &&
    book.yesSpread > config.maxSpread
  ) {
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

  // Prefer explicit YES ask; NO can be taken via noAsk or inferred from yesBid.
  if (book.yesAsk !== null && book.yesAsk <= enterYesCeiling) {
    const edge = FAIR_PROBABILITY - book.yesAsk;
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
      direction: "YES",
      limitPriceHint: book.yesAsk,
      edge,
      edgeThreshold: config.edgeThreshold,
      fairProbability: FAIR_PROBABILITY,
      book,
      secondsToExpiry: secondsLeft,
      tradable: market.tradable,
      finalized: market.finalized,
      indexerStatus: market.indexerStatus,
      onchainStatus: market.onchainStatus,
      reason: `YES ask ${book.yesAsk.toFixed(4)} is at least ${config.edgeThreshold} below fair ${FAIR_PROBABILITY} (edge ${edge.toFixed(4)}).`,
      skipCode: null,
    };
  }

  if (book.noAsk !== null && book.noAsk <= enterYesCeiling) {
    const edge = FAIR_PROBABILITY - book.noAsk;
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
      direction: "NO",
      limitPriceHint: book.noAsk,
      edge,
      edgeThreshold: config.edgeThreshold,
      fairProbability: FAIR_PROBABILITY,
      book,
      secondsToExpiry: secondsLeft,
      tradable: market.tradable,
      finalized: market.finalized,
      indexerStatus: market.indexerStatus,
      onchainStatus: market.onchainStatus,
      reason: `NO ask ${book.noAsk.toFixed(4)} is at least ${config.edgeThreshold} below fair ${FAIR_PROBABILITY} (edge ${edge.toFixed(4)}).`,
      skipCode: null,
    };
  }

  // Implied cheap NO: expensive YES ask means market prices YES high.
  if (book.yesAsk !== null && book.yesAsk >= enterNoFloor) {
    const edge = book.yesAsk - FAIR_PROBABILITY;
    const impliedNo = 1 - book.yesAsk;
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
      direction: "NO",
      limitPriceHint: book.noAsk ?? Math.max(impliedNo, 0),
      edge,
      edgeThreshold: config.edgeThreshold,
      fairProbability: FAIR_PROBABILITY,
      book,
      secondsToExpiry: secondsLeft,
      tradable: market.tradable,
      finalized: market.finalized,
      indexerStatus: market.indexerStatus,
      onchainStatus: market.onchainStatus,
      reason: `YES ask ${book.yesAsk.toFixed(4)} is at least ${config.edgeThreshold} above fair; prefer NO (implied ~${impliedNo.toFixed(4)}).`,
      skipCode: null,
    };
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

/** Evaluate many markets; enters sorted by edge descending. */
export function evaluateMarkets(
  markets: DreamdexMarketDiagnostic[],
  nowSeconds: number = Date.now() / 1000,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyRunResult {
  const decisions = markets.map((market) =>
    evaluateMarket(market, nowSeconds, config),
  );

  const enters = decisions
    .filter((d) => d.action === "enter")
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0));
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

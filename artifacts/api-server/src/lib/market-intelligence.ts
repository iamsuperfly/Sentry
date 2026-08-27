/**
 * Per-scan market intelligence counters and liquidity classification.
 * Pure aggregation over DreamdexMarketDiagnostic-like rows.
 */

import {
  classifyMarketDuration,
  emptyDurationHistogram,
  type DurationBucket,
} from "./market-duration.ts";

export type IntelligenceMarket = {
  marketId: string;
  asset: string;
  tradable: boolean;
  finalized: boolean;
  intervalSec?: string | number | null;
  tradingStart?: string | number | null;
  expiry?: string | number | null;
  decimals: number;
  book: {
    yesBids: Array<{ price: string; quantity: string }>;
    yesAsks: Array<{ price: string; quantity: string }>;
    noBids: Array<{ price: string; quantity: string }>;
    noAsks: Array<{ price: string; quantity: string }>;
  };
  tradeCount?: number | null;
};

export type MarketIntelligenceSummary = {
  discovered: number;
  supported: number;
  tradable: number;
  withUsableAsks: number;
  byDuration: Record<DurationBucket, number>;
  tradableByDuration: Record<DurationBucket, number>;
  btc: number;
  eth: number;
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

export function marketHasUsableAsk(market: IntelligenceMarket): boolean {
  const yesAsk = levelPrice(market.book.yesAsks, market.decimals);
  const noAsk = levelPrice(market.book.noAsks, market.decimals);
  return yesAsk !== null || noAsk !== null;
}

export function summarizeMarketIntelligence(
  markets: IntelligenceMarket[],
): MarketIntelligenceSummary {
  const byDuration = emptyDurationHistogram();
  const tradableByDuration = emptyDurationHistogram();
  let tradable = 0;
  let withUsableAsks = 0;
  let btc = 0;
  let eth = 0;

  for (const m of markets) {
    const asset = m.asset.toUpperCase();
    if (asset === "BTC") btc++;
    if (asset === "ETH") eth++;
    const { bucket } = classifyMarketDuration({
      intervalSec: m.intervalSec,
      tradingStart: m.tradingStart,
      expiry: m.expiry,
    });
    byDuration[bucket]++;
    if (m.tradable && !m.finalized) {
      tradable++;
      tradableByDuration[bucket]++;
      if (marketHasUsableAsk(m)) withUsableAsks++;
    }
  }

  return {
    discovered: markets.length,
    supported: markets.length,
    tradable,
    withUsableAsks,
    byDuration,
    tradableByDuration,
    btc,
    eth,
  };
}

export function formatScanSummaryLines(
  s: MarketIntelligenceSummary & {
    aiCandidates?: number;
    availableSlots?: number;
    selected?: number;
  },
): string[] {
  const lines = [
    `Markets in this scan: ${s.discovered}`,
    `BTC: ${s.btc} · ETH: ${s.eth}`,
    `Tradable: ${s.tradable} · With usable asks: ${s.withUsableAsks}`,
    `Durations (all): 1m=${s.byDuration["1m"]} 5m=${s.byDuration["5m"]} 15m=${s.byDuration["15m"]} 30m=${s.byDuration["30m"]} 1h=${s.byDuration["1h"]} 4h=${s.byDuration["4h"]} 1d=${s.byDuration["1d"]} other=${s.byDuration.unknown}`,
  ];
  if (s.aiCandidates !== undefined) lines.push(`AI candidates: ${s.aiCandidates}`);
  if (s.availableSlots !== undefined)
    lines.push(`Available position slots: ${s.availableSlots}`);
  if (s.selected !== undefined) lines.push(`Selected: ${s.selected}`);
  return lines;
}

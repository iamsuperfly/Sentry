import {
  binanceSymbolForAsset,
  fetchBinanceSpotPrice,
  isQuoteFresh,
  type SpotPriceQuote,
  type SpotPriceResult,
} from "./binance-spot.ts";

export function parseMarketStrike(
  raw: string | number | null | undefined,
): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function calculateGapBps(
  spot: number | null | undefined,
  strike: number | null | undefined,
): number | null {
  if (
    spot === null ||
    spot === undefined ||
    strike === null ||
    strike === undefined ||
    !Number.isFinite(spot) ||
    !Number.isFinite(strike) ||
    spot <= 0 ||
    strike <= 0
  ) {
    return null;
  }
  return Math.round(((spot / strike - 1) * 10_000 + Number.EPSILON) * 100) / 100;
}

export type GroqSpotMarket = {
  asset: string;
  strike?: string | number | null;
};

export function enrichGroqMarketWithSpot<T extends GroqSpotMarket>(
  market: T,
  result: SpotPriceResult | undefined,
): T & { spot?: number; gapBps?: number } {
  if (!result?.ok) return market;

  const strike = parseMarketStrike(market.strike);
  const gapBps = calculateGapBps(result.quote.price, strike);
  return {
    ...market,
    spot: result.quote.price,
    ...(gapBps === null ? {} : { gapBps }),
  };
}

export async function fetchGroqSpotQuotes(
  markets: Array<{ asset: string }>,
  options: {
    fetchImpl?: typeof fetch;
    nowMs?: number;
    seedQuotes?: ReadonlyMap<string, SpotPriceQuote>;
  } = {},
): Promise<Map<string, SpotPriceResult>> {
  const assets = [
    ...new Set(
      markets
        .map((market) => market.asset.trim().toUpperCase())
        .filter((asset) => binanceSymbolForAsset(asset) !== null),
    ),
  ];
  const nowMs = options.nowMs ?? Date.now();
  const results = new Map<string, SpotPriceResult>();

  await Promise.all(
    assets.map(async (asset) => {
      const seeded = options.seedQuotes?.get(asset);
      if (seeded && isQuoteFresh(seeded, nowMs)) {
        results.set(asset, { ok: true, quote: seeded });
        return;
      }
      results.set(
        asset,
        await fetchBinanceSpotPrice({
          asset,
          fetchImpl: options.fetchImpl,
        }),
      );
    }),
  );

  return results;
}
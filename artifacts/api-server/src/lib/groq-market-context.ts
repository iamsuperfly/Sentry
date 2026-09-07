import {
  binanceSymbolForAsset,
  fetchBinanceSpotPrice,
  isQuoteFresh,
  type SpotPriceQuote,
  type SpotPriceResult,
} from "./binance-spot.ts";
import { parseFixedStrike, calculateReferenceGapBps } from "./reference-price.ts";
import {
  getBinanceFeatureSnapshot,
  getCachedSpotQuote,
} from "./binance-sampler.ts";
import { featuresForDuration } from "./binance-features.ts";

export function parseMarketStrike(
  raw: string | number | null | undefined,
): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  return parseFixedStrike(raw);
}

export function calculateGapBps(
  spot: number | null | undefined,
  referencePrice: number | null | undefined,
): number | null {
  return calculateReferenceGapBps(spot, referencePrice);
}

export type GroqSpotMarket = {
  asset: string;
  durationBucket?: string;
  strike?: string | number | null;
  referenceType?: "strike" | "opening";
  referencePrice?: number | null;
  referenceDecimals?: number | null;
};

export function enrichGroqMarketWithSpot<T extends GroqSpotMarket>(
  market: T,
  result: SpotPriceResult | undefined,
): T & { spot?: number; gapBps?: number } & Record<string, unknown> {
  const referencePrice =
    market.referencePrice ?? parseMarketStrike(market.strike);
  const snapshot = getBinanceFeatureSnapshot(market.asset, {
    referencePrice,
  });
  const durationFeatures = featuresForDuration(
    snapshot,
    market.durationBucket ?? "15m",
  );

  if (!result?.ok) {
    if (snapshot.stale || snapshot.spot === null) {
      return { ...market, ...durationFeatures };
    }
    const gapBps = calculateGapBps(snapshot.spot, referencePrice);
    return {
      ...market,
      spot: snapshot.spot,
      ...(gapBps === null ? {} : { gapBps }),
      ...durationFeatures,
    };
  }

  const gapBps = calculateGapBps(result.quote.price, referencePrice);
  return {
    ...market,
    spot: result.quote.price,
    ...(gapBps === null ? {} : { gapBps }),
    ...durationFeatures,
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
      const cached = getCachedSpotQuote(asset, nowMs);
      if (cached && !options.fetchImpl) {
        results.set(asset, {
          ok: true,
          quote: {
            provider: "binance",
            symbol: binanceSymbolForAsset(asset) ?? `${asset}USDT`,
            asset,
            price: cached.price,
            fetchedAtMs: cached.fetchedAtMs,
          },
        });
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

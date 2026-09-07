import {
  binanceSymbolForAsset,
  fetchBinanceSpotPrice,
  isQuoteFresh,
  type SpotPriceQuote,
  type SpotPriceResult,
} from "./binance-spot.ts";
import { parseFixedStrike, calculateReferenceGapBps } from "./reference-price.ts";

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
  strike?: string | number | null;
  referenceType?: "strike" | "opening";
  referencePrice?: number | null;
  referenceDecimals?: number | null;
};

export function enrichGroqMarketWithSpot<T extends GroqSpotMarket>(
  market: T,
  result: SpotPriceResult | undefined,
): T & { spot?: number; gapBps?: number } {
  if (!result?.ok) return market;

  const referencePrice =
    market.referencePrice ?? parseMarketStrike(market.strike);
  const gapBps = calculateGapBps(result.quote.price, referencePrice);
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
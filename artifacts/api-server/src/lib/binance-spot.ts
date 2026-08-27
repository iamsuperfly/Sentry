/**
 * Public Binance spot price feed (no API key).
 * Uses market-data-only host; never signs requests or uses private endpoints.
 */

export const BINANCE_SPOT_BASE = "https://data-api.binance.vision";

export type BinanceAsset = "BTC" | "ETH";

const SYMBOL_BY_ASSET: Record<BinanceAsset, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
};

export function binanceSymbolForAsset(asset: string): string | null {
  const a = asset.trim().toUpperCase();
  if (a === "BTC" || a === "ETH") return SYMBOL_BY_ASSET[a];
  return null;
}

export type SpotPriceQuote = {
  provider: "binance";
  symbol: string;
  asset: string;
  price: number;
  fetchedAtMs: number;
};

export type SpotPriceResult =
  | { ok: true; quote: SpotPriceQuote }
  | { ok: false; code: string; reason: string };

/**
 * GET /api/v3/ticker/price?symbol=BTCUSDT — public, no auth.
 * @see https://developers.binance.com/legacy-docs/binance-spot-api-docs/faqs/market_data_only
 */
export async function fetchBinanceSpotPrice(input: {
  asset: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<SpotPriceResult> {
  const symbol = binanceSymbolForAsset(input.asset);
  if (!symbol) {
    return {
      ok: false,
      code: "unsupported_asset",
      reason: `No Binance symbol mapping for asset ${input.asset}.`,
    };
  }

  const base = (input.baseUrl ?? BINANCE_SPOT_BASE).replace(/\/$/, "");
  const url = `${base}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const fetchFn = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        code: "binance_http_error",
        reason: `Binance ticker HTTP ${res.status}.`,
      };
    }
    const body = (await res.json()) as { symbol?: string; price?: string };
    const raw = body.price;
    const price = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(price) || price <= 0) {
      return {
        ok: false,
        code: "binance_invalid_price",
        reason: "Binance returned a missing or non-positive price.",
      };
    }
    return {
      ok: true,
      quote: {
        provider: "binance",
        symbol,
        asset: input.asset.toUpperCase(),
        price,
        fetchedAtMs: Date.now(),
      },
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "binance_timeout" : "binance_network_error",
      reason: aborted
        ? "Binance ticker request timed out."
        : "Binance ticker network error.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Max age for a quote before it is treated as stale (ms). */
export const SPOT_QUOTE_MAX_AGE_MS = 3_000;

export function isQuoteFresh(
  quote: SpotPriceQuote,
  nowMs: number = Date.now(),
  maxAgeMs: number = SPOT_QUOTE_MAX_AGE_MS,
): boolean {
  return nowMs - quote.fetchedAtMs <= maxAgeMs && quote.price > 0;
}

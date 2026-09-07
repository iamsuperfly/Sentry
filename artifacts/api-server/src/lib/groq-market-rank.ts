/** Cheap local ranking before Groq. Uses snapshot fields already collected. */

export type GroqRankMarket = {
  marketId: string;
  asset: string;
  durationBucket: string;
  secondsToExpiry: number | null;
  yesAsk: number | null;
  noAsk: number | null;
  spread: number | null;
  topAskQuantity: number | null;
  yesAskQuantity?: number | null;
  noAskQuantity?: number | null;
  strike?: string;
  referenceType?: "strike" | "opening";
  referencePrice?: number;
  referenceDecimals?: number | null;
  spot?: number;
  gapBps?: number;
};

export const DEFAULT_GROQ_MARKET_CAP = 8;

export function resolveGroqMarketCap(raw?: string | number | null): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GROQ_MARKET_CAP;
  return Math.min(24, Math.floor(n));
}

function midAsk(m: GroqRankMarket): number | null {
  const asks = [m.yesAsk, m.noAsk].filter(
    (v): v is number => v !== null && Number.isFinite(v) && v > 0 && v < 1,
  );
  if (asks.length === 0) return null;
  return Math.min(...asks);
}

export function scoreMarketForGroq(m: GroqRankMarket): number {
  let score = 0;
  const ask = midAsk(m);
  if (ask === null) return -1000;
  if (ask >= 0.35 && ask <= 0.72) score += 30;
  else if (ask >= 0.25 && ask <= 0.8) score += 16;
  else score += 4;

  if (m.spread !== null && Number.isFinite(m.spread)) {
    if (m.spread <= 0.03) score += 24;
    else if (m.spread <= 0.06) score += 14;
    else if (m.spread <= 0.1) score += 6;
    else score -= 8;
  }

  const qty = m.topAskQuantity;
  if (qty !== null && Number.isFinite(qty) && qty > 0) {
    if (qty >= 40) score += 16;
    else if (qty >= 15) score += 10;
    else if (qty >= 5) score += 4;
  }

  const left = m.secondsToExpiry;
  if (left !== null && Number.isFinite(left)) {
    if (left < 90) score -= 40;
    else if (left < 180) score -= 10;
    else if (left <= 6 * 3600) score += 12;
    else if (left <= 24 * 3600) score += 4;
    else score -= 6;
  }

  if (m.durationBucket === "15m" || m.durationBucket === "1h") {
    score += 8;
  } else if (m.durationBucket === "5m") {
    score += 3;
  }

  return score;
}

export function rankMarketsForGroq<T extends GroqRankMarket>(
  markets: T[],
  cap = DEFAULT_GROQ_MARKET_CAP,
): T[] {
  const limit = resolveGroqMarketCap(cap);
  return [...markets]
    .filter((m) => midAsk(m) !== null)
    .sort((a, b) => scoreMarketForGroq(b) - scoreMarketForGroq(a))
    .slice(0, limit);
}

export function compactAiMarket(m: GroqRankMarket): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: m.marketId,
    a: m.asset,
    d: m.durationBucket,
    left: m.secondsToExpiry,
    yA: m.yesAsk,
    nA: m.noAsk,
    spr: m.spread,
  };
  if (m.topAskQuantity !== null) row.qty = m.topAskQuantity;
  if (m.strike) row.strike = m.strike;
  if (m.referenceType) row.refType = m.referenceType;
  if (m.referencePrice !== undefined && Number.isFinite(m.referencePrice)) {
    row.ref = m.referencePrice;
  }
  if (m.referenceDecimals !== undefined && m.referenceDecimals !== null) {
    row.refDp = m.referenceDecimals;
  }
  if (m.spot !== undefined && Number.isFinite(m.spot)) row.spot = m.spot;
  if (m.gapBps !== undefined && Number.isFinite(m.gapBps)) row.gapBps = m.gapBps;
  if (
    (m.yesAskQuantity !== undefined && m.yesAskQuantity !== null) ||
    (m.noAskQuantity !== undefined && m.noAskQuantity !== null)
  ) {
    row.depth = {
      yes: m.yesAskQuantity ?? null,
      no: m.noAskQuantity ?? null,
    };
  }
  return row;
}

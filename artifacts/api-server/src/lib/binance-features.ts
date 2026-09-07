/**
 * Compact, deterministic features from a bounded Binance price history.
 * Pure — no network.
 */

export type PriceObservation = {
  asset: string;
  price: number;
  observedAtMs: number;
};

export type BinanceFeatureSnapshot = {
  asset: string;
  spot: number | null;
  observedAtMs: number | null;
  change1mBps: number | null;
  change3mBps: number | null;
  change5mBps: number | null;
  change10mBps: number | null;
  change15mBps: number | null;
  change30mBps: number | null;
  trend: "up" | "down" | "flat" | null;
  volatilityBps: number | null;
  gapBps: number | null;
  stale: boolean;
  sampleCount: number;
};

export const FEATURE_WINDOWS_MS = {
  m1: 60_000,
  m3: 180_000,
  m5: 300_000,
  m10: 600_000,
  m15: 900_000,
  m30: 1_800_000,
} as const;

export const BINANCE_STALE_AFTER_MS = 45_000;

export function changeBps(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    return null;
  }
  return Math.round(((to / from - 1) * 10_000 + Number.EPSILON) * 100) / 100;
}

function priceAtOrBefore(
  observations: readonly PriceObservation[],
  targetMs: number,
): PriceObservation | null {
  let best: PriceObservation | null = null;
  for (const row of observations) {
    if (row.observedAtMs <= targetMs) {
      if (!best || row.observedAtMs > best.observedAtMs) best = row;
    }
  }
  return best;
}

function sampleStdevBps(observations: readonly PriceObservation[]): number | null {
  if (observations.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < observations.length; i++) {
    const prev = observations[i - 1]!;
    const cur = observations[i]!;
    const bps = changeBps(prev.price, cur.price);
    if (bps !== null) returns.push(bps);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);
  return Math.round((Math.sqrt(variance) + Number.EPSILON) * 100) / 100;
}

export function classifyTrend(
  change1mBps: number | null,
  change5mBps: number | null,
): "up" | "down" | "flat" | null {
  const primary = change5mBps ?? change1mBps;
  if (primary === null) return null;
  if (primary >= 8) return "up";
  if (primary <= -8) return "down";
  return "flat";
}

export function deriveBinanceFeatures(input: {
  asset: string;
  observations: readonly PriceObservation[];
  nowMs?: number;
  staleAfterMs?: number;
  referencePrice?: number | null;
}): BinanceFeatureSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? BINANCE_STALE_AFTER_MS;
  const rows = input.observations
    .filter(
      (row) =>
        row.asset.toUpperCase() === input.asset.toUpperCase() &&
        Number.isFinite(row.price) &&
        row.price > 0,
    )
    .slice()
    .sort((a, b) => a.observedAtMs - b.observedAtMs);

  const latest = rows.length > 0 ? rows[rows.length - 1]! : null;
  const stale =
    latest === null || nowMs - latest.observedAtMs > staleAfterMs;

  const windowChange = (windowMs: number): number | null => {
    if (!latest || stale) return null;
    const past = priceAtOrBefore(rows, latest.observedAtMs - windowMs);
    if (!past) return null;
    return changeBps(past.price, latest.price);
  };

  const change1mBps = windowChange(FEATURE_WINDOWS_MS.m1);
  const change3mBps = windowChange(FEATURE_WINDOWS_MS.m3);
  const change5mBps = windowChange(FEATURE_WINDOWS_MS.m5);
  const recent = rows.filter((row) => latest && latest.observedAtMs - row.observedAtMs <= FEATURE_WINDOWS_MS.m5);

  return {
    asset: input.asset.toUpperCase(),
    spot: stale ? null : latest?.price ?? null,
    observedAtMs: latest?.observedAtMs ?? null,
    change1mBps,
    change3mBps,
    change5mBps,
    change10mBps: windowChange(FEATURE_WINDOWS_MS.m10),
    change15mBps: windowChange(FEATURE_WINDOWS_MS.m15),
    change30mBps: windowChange(FEATURE_WINDOWS_MS.m30),
    trend: stale ? null : classifyTrend(change1mBps, change5mBps),
    volatilityBps: stale ? null : sampleStdevBps(recent),
    gapBps:
      stale || latest === null
        ? null
        : changeBps(input.referencePrice ?? NaN, latest.price),
    stale,
    sampleCount: rows.length,
  };
}

export function featuresForDuration(
  snapshot: BinanceFeatureSnapshot,
  durationBucket: string,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (snapshot.spot !== null) row.spot = snapshot.spot;
  if (snapshot.gapBps !== null) row.gapBps = snapshot.gapBps;
  if (snapshot.trend) row.trend = snapshot.trend;
  if (snapshot.volatilityBps !== null) row.vol = snapshot.volatilityBps;

  const include = (key: string, value: number | null) => {
    if (value !== null) row[key] = value;
  };

  if (durationBucket === "5m") {
    include("ch1", snapshot.change1mBps);
    include("ch3", snapshot.change3mBps);
    include("ch5", snapshot.change5mBps);
  } else if (durationBucket === "15m") {
    include("ch3", snapshot.change3mBps);
    include("ch5", snapshot.change5mBps);
    include("ch10", snapshot.change10mBps);
    include("ch15", snapshot.change15mBps);
  } else if (durationBucket === "1h") {
    include("ch5", snapshot.change5mBps);
    include("ch15", snapshot.change15mBps);
    include("ch30", snapshot.change30mBps);
  } else {
    include("ch15", snapshot.change15mBps);
    include("ch30", snapshot.change30mBps);
  }
  return row;
}

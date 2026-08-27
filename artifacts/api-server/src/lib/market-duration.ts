/**
 * Duration classification for DreamDEX binary markets.
 * Pure — no network. Prefer computed window (expiry - tradingStart) when intervalSec is odd.
 */

export type DurationBucket =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "4h"
  | "1d"
  | "unknown";

const STANDARD_SEC: Record<Exclude<DurationBucket, "unknown">, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

const TOLERANCE = 5;

function parseUnixSeconds(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return n >= 1e12 ? n / 1000 : n;
}

export function resolveWindowSeconds(input: {
  intervalSec?: string | number | null;
  tradingStart?: string | number | null;
  expiry?: string | number | null;
}): {
  windowSec: number | null;
  intervalSec: number | null;
  source: "interval" | "window" | "both_agree" | "none";
} {
  const intervalRaw =
    input.intervalSec === null || input.intervalSec === undefined
      ? null
      : Number(input.intervalSec);
  const intervalSec =
    intervalRaw !== null && Number.isFinite(intervalRaw) && intervalRaw > 0
      ? intervalRaw
      : null;

  const start = parseUnixSeconds(input.tradingStart);
  const end = parseUnixSeconds(input.expiry);
  const windowSec =
    start !== null && end !== null && end > start ? end - start : null;

  if (intervalSec !== null && windowSec !== null) {
    if (Math.abs(intervalSec - windowSec) <= TOLERANCE) {
      return { windowSec, intervalSec, source: "both_agree" };
    }
    return { windowSec, intervalSec, source: "window" };
  }
  if (windowSec !== null) return { windowSec, intervalSec, source: "window" };
  if (intervalSec !== null)
    return { windowSec: intervalSec, intervalSec, source: "interval" };
  return { windowSec: null, intervalSec: null, source: "none" };
}

export function classifyDurationBucket(windowSec: number | null): DurationBucket {
  if (windowSec === null || !Number.isFinite(windowSec) || windowSec <= 0) {
    return "unknown";
  }
  for (const [label, sec] of Object.entries(STANDARD_SEC) as Array<
    [Exclude<DurationBucket, "unknown">, number]
  >) {
    if (Math.abs(windowSec - sec) <= TOLERANCE) return label;
  }
  return "unknown";
}

export function classifyMarketDuration(input: {
  intervalSec?: string | number | null;
  tradingStart?: string | number | null;
  expiry?: string | number | null;
}): {
  bucket: DurationBucket;
  windowSec: number | null;
  intervalSec: number | null;
  source: "interval" | "window" | "both_agree" | "none";
} {
  const resolved = resolveWindowSeconds(input);
  return {
    bucket: classifyDurationBucket(resolved.windowSec),
    windowSec: resolved.windowSec,
    intervalSec: resolved.intervalSec,
    source: resolved.source,
  };
}

export function emptyDurationHistogram(): Record<DurationBucket, number> {
  return {
    "1m": 0,
    "5m": 0,
    "15m": 0,
    "30m": 0,
    "1h": 0,
    "4h": 0,
    "1d": 0,
    unknown: 0,
  };
}

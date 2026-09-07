/**
 * Independent Binance BTC/ETH spot sampler.
 * REST poll every ~15s into a bounded in-memory cache.
 * Never blocks the autonomous scan. Failures stay local.
 */

import {
  fetchBinanceSpotPrice,
  type BinanceAsset,
} from "./binance-spot.ts";
import {
  BINANCE_STALE_AFTER_MS,
  deriveBinanceFeatures,
  type BinanceFeatureSnapshot,
  type PriceObservation,
} from "./binance-features.ts";
import { logger } from "./logger.ts";

export const BINANCE_SAMPLE_INTERVAL_MS = 15_000;
export const BINANCE_HEARTBEAT_INTERVAL_MS = 60_000;
export const BINANCE_MAX_HISTORY_MS = 30 * 60_000;
export const BINANCE_MAX_SAMPLES_PER_ASSET = Math.ceil(
  BINANCE_MAX_HISTORY_MS / BINANCE_SAMPLE_INTERVAL_MS,
) + 8;

const ASSETS: BinanceAsset[] = ["BTC", "ETH"];

type SamplerState = {
  started: boolean;
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  observations: Map<string, PriceObservation[]>;
  fetchImpl?: typeof fetch;
  nowMs: () => number;
};

const state: SamplerState = {
  started: false,
  stopped: false,
  timer: null,
  heartbeat: null,
  observations: new Map(),
  nowMs: () => Date.now(),
};

function trimAsset(asset: string, nowMs: number): void {
  const rows = state.observations.get(asset) ?? [];
  const cutoff = nowMs - BINANCE_MAX_HISTORY_MS;
  const kept = rows.filter((row) => row.observedAtMs >= cutoff);
  if (kept.length > BINANCE_MAX_SAMPLES_PER_ASSET) {
    kept.splice(0, kept.length - BINANCE_MAX_SAMPLES_PER_ASSET);
  }
  state.observations.set(asset, kept);
}

export function recordObservation(
  observation: PriceObservation,
  nowMs: number = state.nowMs(),
): void {
  if (
    !Number.isFinite(observation.price) ||
    observation.price <= 0 ||
    !Number.isFinite(observation.observedAtMs)
  ) {
    return;
  }
  const asset = observation.asset.trim().toUpperCase();
  const rows = state.observations.get(asset) ?? [];
  rows.push({
    asset,
    price: observation.price,
    observedAtMs: observation.observedAtMs,
  });
  state.observations.set(asset, rows);
  trimAsset(asset, nowMs);
}

export function listObservations(asset: string): PriceObservation[] {
  return [...(state.observations.get(asset.trim().toUpperCase()) ?? [])];
}

export function getBinanceFeatureSnapshot(
  asset: string,
  options?: { nowMs?: number; referencePrice?: number | null },
): BinanceFeatureSnapshot {
  return deriveBinanceFeatures({
    asset,
    observations: listObservations(asset),
    nowMs: options?.nowMs ?? state.nowMs(),
    staleAfterMs: BINANCE_STALE_AFTER_MS,
    referencePrice: options?.referencePrice,
  });
}

export function getCachedSpotQuote(
  asset: string,
  nowMs: number = state.nowMs(),
): { price: number; fetchedAtMs: number } | null {
  const snapshot = getBinanceFeatureSnapshot(asset, { nowMs });
  if (snapshot.stale || snapshot.spot === null || snapshot.observedAtMs === null) {
    return null;
  }
  return { price: snapshot.spot, fetchedAtMs: snapshot.observedAtMs };
}

export function isSamplerRunning(): boolean {
  return state.started && !state.stopped;
}

async function pollOnce(): Promise<void> {
  const nowMs = state.nowMs();
  await Promise.all(
    ASSETS.map(async (asset) => {
      try {
        const result = await fetchBinanceSpotPrice({
          asset,
          fetchImpl: state.fetchImpl,
        });
        if (!result.ok) {
          logger.warn(
            { asset, code: result.code, reason: result.reason },
            "Binance sampler poll failed",
          );
          return;
        }
        recordObservation(
          {
            asset,
            price: result.quote.price,
            observedAtMs: result.quote.fetchedAtMs,
          },
          nowMs,
        );
      } catch (error) {
        logger.warn(
          {
            asset,
            err: error instanceof Error ? error.message.slice(0, 160) : "poll error",
          },
          "Binance sampler poll threw",
        );
      }
    }),
  );
}

function heartbeat(): void {
  for (const asset of ASSETS) {
    const snap = getBinanceFeatureSnapshot(asset);
    const spot = snap.spot === null ? "n/a" : `$${snap.spot}`;
    const ch1 = snap.change1mBps === null ? "n/a" : `${snap.change1mBps}bps`;
    const ch5 = snap.change5mBps === null ? "n/a" : `${snap.change5mBps}bps`;
    logger.info(
      {
        asset,
        spot: snap.spot,
        change1mBps: snap.change1mBps,
        change5mBps: snap.change5mBps,
        stale: snap.stale,
        samples: snap.sampleCount,
      },
      `BINANCE ${asset} ${spot} | 1m ${ch1} | 5m ${ch5}`,
    );
  }
}

export function startBinanceSampler(options?: {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  intervalMs?: number;
  heartbeatMs?: number;
}): { stop: () => void } {
  if (state.started && !state.stopped) {
    return { stop: stopBinanceSampler };
  }
  state.started = true;
  state.stopped = false;
  state.fetchImpl = options?.fetchImpl;
  if (options?.nowMs) state.nowMs = options.nowMs;
  const intervalMs = options?.intervalMs ?? BINANCE_SAMPLE_INTERVAL_MS;
  const heartbeatMs = options?.heartbeatMs ?? BINANCE_HEARTBEAT_INTERVAL_MS;

  void pollOnce().catch((error) => {
    logger.warn(
      { err: error instanceof Error ? error.message : "startup poll" },
      "Binance sampler startup poll failed",
    );
  });

  state.timer = setInterval(() => {
    void pollOnce();
  }, intervalMs);
  state.heartbeat = setInterval(() => {
    try {
      heartbeat();
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : "heartbeat" },
        "Binance sampler heartbeat failed",
      );
    }
  }, heartbeatMs);

  logger.info({ intervalMs, assets: ASSETS }, "Binance sampler started");
  return { stop: stopBinanceSampler };
}

export function stopBinanceSampler(): void {
  state.stopped = true;
  if (state.timer) clearInterval(state.timer);
  if (state.heartbeat) clearInterval(state.heartbeat);
  state.timer = null;
  state.heartbeat = null;
  state.started = false;
  logger.info("Binance sampler stopped");
}

export function resetBinanceSamplerForTests(): void {
  stopBinanceSampler();
  state.observations.clear();
  state.stopped = false;
  state.started = false;
  state.fetchImpl = undefined;
  state.nowMs = () => Date.now();
}

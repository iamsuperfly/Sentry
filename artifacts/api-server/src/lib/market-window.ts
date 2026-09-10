/**
 * DreamDEX identity: marketId is the market, (pool, nonce) is the window.
 * A reused pool with a new nonce/marketId is a new window.
 */

export type MarketWindowIdentity = {
  marketId: string;
  poolAddress: string;
  poolNonce: string;
};

export function normalizeHex(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function windowKey(id: MarketWindowIdentity): string {
  return `${normalizeHex(id.marketId)}:${normalizeHex(id.poolAddress)}:${String(id.poolNonce)}`;
}

export function poolKey(poolAddress: string): string {
  return normalizeHex(poolAddress);
}

export type WindowChange =
  | { changed: false }
  | {
      changed: true;
      reason: "new_pool" | "new_market" | "new_nonce";
      previous: MarketWindowIdentity | null;
      next: MarketWindowIdentity;
    };

export function detectWindowChange(
  previous: MarketWindowIdentity | null | undefined,
  next: MarketWindowIdentity,
): WindowChange {
  if (!previous) {
    return { changed: true, reason: "new_pool", previous: null, next };
  }
  if (normalizeHex(previous.marketId) !== normalizeHex(next.marketId)) {
    return { changed: true, reason: "new_market", previous, next };
  }
  if (String(previous.poolNonce) !== String(next.poolNonce)) {
    return { changed: true, reason: "new_nonce", previous, next };
  }
  if (normalizeHex(previous.poolAddress) !== normalizeHex(next.poolAddress)) {
    return { changed: true, reason: "new_pool", previous, next };
  }
  return { changed: false };
}

/** Process-level last-seen window per pool. Not per-user. */
const lastWindowByPool = new Map<string, MarketWindowIdentity>();

export function rememberWindow(next: MarketWindowIdentity): WindowChange {
  const key = poolKey(next.poolAddress);
  const previous = lastWindowByPool.get(key) ?? null;
  const change = detectWindowChange(previous, next);
  lastWindowByPool.set(key, {
    marketId: normalizeHex(next.marketId),
    poolAddress: normalizeHex(next.poolAddress),
    poolNonce: String(next.poolNonce),
  });
  return change;
}

export function resetWindowStateForPool(poolAddress: string): void {
  lastWindowByPool.delete(poolKey(poolAddress));
}

export function clearWindowState(): void {
  lastWindowByPool.clear();
}

export function getRememberedWindow(poolAddress: string): MarketWindowIdentity | null {
  return lastWindowByPool.get(poolKey(poolAddress)) ?? null;
}

/**
 * Process-level DreamDEX live tail. One shared connection, not per user.
 * Events trigger the existing engine (finalization / autonomous). They do not
 * decide trades. The 6-minute loop remains the reconciliation fallback.
 */

import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { AppConfig } from "../config.ts";
import { logger } from "./logger.ts";
import {
  rememberWindow,
  type MarketWindowIdentity,
} from "./market-window.ts";
import { getSharedSomniaExchange } from "./somnia-client.ts";

export type ProtocolEventKind =
  | "market_live"
  | "new_window"
  | "locked"
  | "resolved"
  | "settlement"
  | "book_change";

export type ProtocolEvent = {
  kind: ProtocolEventKind;
  marketId?: string;
  poolAddress?: string;
  poolNonce?: string;
};

export type ProtocolEventHandlers = {
  /** Existing engine: settlement/claim/finalization. */
  onLifecycle?: (event: ProtocolEvent) => void;
  /** Existing engine: discovery → strategy → risk → execution. */
  onTradingOpportunity?: (event: ProtocolEvent) => void;
};

const SETTLEMENT_STATUSES = new Set([
  "Locked",
  "Settling",
  "Resolved",
  "Voided",
  "Finalized",
]);

type LiveRow = {
  marketType?: string;
  marketId?: string;
  id?: string;
  poolAddress?: string;
  nonce?: string | number | bigint | null;
  status?: string;
  clobStatus?: string;
};

type TopLevel = { price: string; quantity: string };

export function isTradingOpportunityKind(kind: ProtocolEventKind): boolean {
  return (
    kind === "market_live" ||
    kind === "new_window" ||
    kind === "book_change"
  );
}

function identityOf(row: LiveRow): MarketWindowIdentity | null {
  if (row.marketType && row.marketType !== "BINARY") return null;
  const marketId = String(row.marketId ?? "");
  const poolAddress = String(row.poolAddress ?? "");
  if (!marketId || !poolAddress) return null;
  return {
    marketId,
    poolAddress,
    poolNonce: row.nonce === undefined || row.nonce === null ? "" : String(row.nonce),
  };
}

function statusOf(row: LiveRow): string {
  return String(row.clobStatus ?? row.status ?? "");
}

export function classifyLiveMarketDelta(input: {
  previous: { status: string; window: MarketWindowIdentity } | null;
  next: LiveRow;
}): ProtocolEvent | null {
  const window = identityOf(input.next);
  if (!window) return null;
  const status = statusOf(input.next);
  const change = input.previous
    ? {
        changed:
          input.previous.window.marketId.toLowerCase() !== window.marketId.toLowerCase() ||
          input.previous.window.poolNonce !== window.poolNonce,
      }
    : { changed: true };

  if (!input.previous) {
    if (status === "Trading" || status === "Listed") {
      return { kind: "market_live", ...window };
    }
    if (SETTLEMENT_STATUSES.has(status)) {
      return {
        kind: status === "Locked" ? "locked" : "settlement",
        ...window,
      };
    }
    return null;
  }

  if (change.changed) {
    return { kind: "new_window", ...window };
  }

  if (input.previous.status !== status) {
    if (status === "Trading") return { kind: "market_live", ...window };
    if (status === "Locked") return { kind: "locked", ...window };
    if (SETTLEMENT_STATUSES.has(status)) return { kind: "settlement", ...window };
  }
  return null;
}

function topOf(levels: Array<{ price?: unknown; quantity?: unknown }> | undefined): TopLevel | null {
  const top = levels?.[0];
  if (!top) return null;
  return {
    price: String(top.price ?? ""),
    quantity: String(top.quantity ?? ""),
  };
}

export function fingerprintBinaryTop(book: {
  yesAsks?: Array<{ price?: unknown; quantity?: unknown }>;
  noAsks?: Array<{ price?: unknown; quantity?: unknown }>;
}): string {
  const yes = topOf(book.yesAsks);
  const no = topOf(book.noAsks);
  return `${yes?.price ?? "-"}:${yes?.quantity ?? "-"}|${no?.price ?? "-"}:${no?.quantity ?? "-"}`;
}

/** First observation is owned by market_live; only later diffs emit book_change. */
export function classifyBookDelta(input: {
  previousFingerprint: string | null;
  nextFingerprint: string;
}): "book_change" | null {
  if (input.previousFingerprint === null) return null;
  if (input.previousFingerprint === input.nextFingerprint) return null;
  return "book_change";
}

function debounceMsFor(opportunity: ProtocolEvent | null, lifecycle: ProtocolEvent | null): number {
  if (opportunity?.kind === "book_change" && !lifecycle) return 1_000;
  return 8_000;
}

function readLiveBook(
  exchange: SomniaMarkets,
  poolAddress: string,
): { fingerprint: string } | null {
  try {
    const status = exchange.client.getWatchStatus(poolAddress);
    if (status !== "live") return null;
    const book = exchange.client.getLiveBinaryOrderBook(poolAddress, { depth: 1 });
    return { fingerprint: fingerprintBinaryTop(book) };
  } catch {
    return null;
  }
}

export function startProtocolEventBus(
  config: AppConfig,
  handlers: ProtocolEventHandlers,
): { stop: () => void } {
  const exchange = getSharedSomniaExchange(config);

  const seen = new Map<string, { status: string; window: MarketWindowIdentity }>();
  const books = new Map<string, string>();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let queuedLifecycle: ProtocolEvent | null = null;
  let queuedOpportunity: ProtocolEvent | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  const flush = () => {
    debounce = null;
    const life = queuedLifecycle;
    const opp = queuedOpportunity;
    queuedLifecycle = null;
    queuedOpportunity = null;
    if (life) handlers.onLifecycle?.(life);
    if (opp) handlers.onTradingOpportunity?.(opp);
  };

  const enqueue = (event: ProtocolEvent) => {
    if (isTradingOpportunityKind(event.kind)) {
      queuedOpportunity = event;
    } else {
      queuedLifecycle = event;
    }
    if (debounce) return;
    debounce = setTimeout(flush, debounceMsFor(queuedOpportunity, queuedLifecycle));
    debounce.unref?.();
  };

  const scan = () => {
    if (stopped) return;
    let rows: LiveRow[] = [];
    try {
      rows = exchange.client.getLiveMarkets() as unknown as LiveRow[];
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message.slice(0, 160) : "live read" },
        "protocol live markets read failed",
      );
      return;
    }
    for (const row of rows) {
      const window = identityOf(row);
      if (!window) continue;
      const poolKey = window.poolAddress.toLowerCase();
      const prev = seen.get(poolKey) ?? null;
      const event = classifyLiveMarketDelta({ previous: prev, next: row });
      const change = rememberWindow(window);
      seen.set(poolKey, {
        status: statusOf(row),
        window,
      });
      if (change.changed && event === null) {
        enqueue({ kind: "new_window", ...window });
        continue;
      }
      if (event) enqueue(event);

      if (statusOf(row) !== "Trading") continue;
      const liveBook = readLiveBook(exchange, window.poolAddress);
      if (!liveBook) continue;
      const prevFp = books.has(poolKey) ? books.get(poolKey)! : null;
      books.set(poolKey, liveBook.fingerprint);
      if (classifyBookDelta({ previousFingerprint: prevFp, nextFingerprint: liveBook.fingerprint })) {
        enqueue({ kind: "book_change", ...window });
      }
    }
  };

  void (async () => {
    try {
      const handle = await exchange.client.watchMarkets({ discover: true });
      void handle;
      unsubscribe = exchange.client.subscribeLive(() => scan());
      logger.info("DreamDEX protocol event bus started (shared WS)");
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message.slice(0, 200) : "watch failed" },
        "protocol event bus failed to watch markets; 6-minute loop remains primary",
      );
    }
  })();

  return {
    stop() {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
      // Shared read client stays up for listing / live submit reads.
    },
  };
}

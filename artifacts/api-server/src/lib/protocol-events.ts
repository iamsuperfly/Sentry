/**
 * Process-level DreamDEX live tail. One shared connection, not per user.
 * Events trigger the existing engine (finalization / autonomous). They do not
 * decide trades. The 6-minute loop remains the reconciliation fallback.
 */

import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import type { AppConfig } from "../config.ts";
import { closeExchange } from "./exchange-lifecycle.ts";
import { logger } from "./logger.ts";
import {
  rememberWindow,
  type MarketWindowIdentity,
} from "./market-window.ts";

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

export function startProtocolEventBus(
  config: AppConfig,
  handlers: ProtocolEventHandlers,
): { stop: () => void } {
  const exchange = new SomniaMarkets({
    chain: somniaShannon,
    wsRpcUrl: config.wsRpcUrl,
    indexerUrl: config.dreamdexIndexerUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });

  const seen = new Map<string, { status: string; window: MarketWindowIdentity }>();
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
    if (event.kind === "market_live" || event.kind === "new_window") {
      queuedOpportunity = event;
    } else if (event.kind !== "book_change") {
      queuedLifecycle = event;
    }
    if (debounce) return;
    debounce = setTimeout(flush, 8_000);
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
      const prev = seen.get(window.poolAddress.toLowerCase()) ?? null;
      const event = classifyLiveMarketDelta({ previous: prev, next: row });
      const change = rememberWindow(window);
      seen.set(window.poolAddress.toLowerCase(), {
        status: statusOf(row),
        window,
      });
      if (change.changed && event === null) {
        enqueue({ kind: "new_window", ...window });
        continue;
      }
      if (event) enqueue(event);
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
      void closeExchange(exchange, { chainTouched: true });
    },
  };
}

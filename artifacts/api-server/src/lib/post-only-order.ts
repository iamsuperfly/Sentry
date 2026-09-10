/**
 * POST_ONLY as an execution capability. Not a strategy. Not a user setting.
 * Strategy SKIP stays skip. ENTER candidates TAKE when the fresh book is
 * executable, otherwise rest at the intended limit when that would not cross.
 */

import type { PreflightBook, PreflightResult } from "./preflight-book.ts";

export const BINARY_ORDER_TYPES = {
  IOC: "IOC",
  POST_ONLY: "POST_ONLY",
} as const;

export type BinaryOrderType = (typeof BINARY_ORDER_TYPES)[keyof typeof BINARY_ORDER_TYPES];

export const POST_ONLY_RESTING_NOTE =
  "post_only_resting: maker order accepted; waiting for fill";

export type PostOnlyDraft = {
  marketId: string;
  poolAddress: string;
  side: "buy";
  outcome: "YES" | "NO";
  orderType: "POST_ONLY";
  limitPrice: number;
  contracts: number;
  stake: number;
  collateral: string;
  decimals: number;
  expireAtSec: number;
  signerRole: "user_wallet";
};

export function isPostOnlyOrderType(value: string | null | undefined): boolean {
  return String(value ?? "").toUpperCase() === "POST_ONLY";
}

export function isPostOnlyRestingNote(raw: string | null | undefined): boolean {
  return Boolean(raw && /post_only_resting/i.test(raw));
}

/** Strategy-facing default remains TAKE/IOC. Execution may override after preflight. */
export function liveEntryOrderType(): "IOC" {
  return "IOC";
}

export type EntryExecutionChoice =
  | { mode: "TAKE" }
  | { mode: "POST_ONLY"; code: "book_stale" | "no_usable_ask"; reason: string }
  | {
      mode: "ABORT";
      code: "insufficient_liquidity" | "post_only_would_cross";
      reason: string;
    };

export function selectEntryExecution(pre: PreflightResult): EntryExecutionChoice {
  if (pre.ok) return { mode: "TAKE" };
  if (pre.code === "book_stale" || pre.code === "no_usable_ask") {
    return { mode: "POST_ONLY", code: pre.code, reason: pre.reason };
  }
  return {
    mode: "ABORT",
    code: "insufficient_liquidity",
    reason: pre.reason,
  };
}

/** Buy POST_ONLY crosses iff a live ask exists at or below the intended limit. */
export function postOnlyWouldCross(input: {
  outcome: "YES" | "NO";
  limitPrice: number;
  book: PreflightBook;
  priceEpsilon?: number;
}): boolean {
  const eps = input.priceEpsilon ?? 1e-9;
  const ask = input.outcome === "YES" ? input.book.yesAsk : input.book.noAsk;
  return ask !== null && ask.price <= input.limitPrice + eps;
}

/** Rest until near market lock, not the 2-minute IOC dead-man. */
export function postOnlyExpireAtSec(nowSec: number, expirySec: number): number {
  const expireAt = expirySec - 15;
  return expireAt > nowSec ? expireAt : Math.max(nowSec + 1, expirySec);
}

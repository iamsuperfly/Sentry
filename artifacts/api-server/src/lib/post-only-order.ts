/**
 * POST_ONLY as an execution capability. Not a strategy. Not a user setting.
 * Live autonomous/manual still use TAKE/IOC (ORDER_TYPE.MARKET).
 */

export const BINARY_ORDER_TYPES = {
  IOC: "IOC",
  POST_ONLY: "POST_ONLY",
} as const;

export type BinaryOrderType = (typeof BINARY_ORDER_TYPES)[keyof typeof BINARY_ORDER_TYPES];

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

/** Strategy-facing default remains TAKE/IOC. */
export function liveEntryOrderType(): "IOC" {
  return "IOC";
}

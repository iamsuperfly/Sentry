import { isAddress, type Address } from "viem";

/** Shared OutcomeToken6909 singleton (Shannon + mainnet CREATE3). */
export const OUTCOME_TOKEN_6909 =
  "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9" as Address;

export type OutcomeTokenSource = "onchain" | "protocol_singleton";

export type ResolvedOutcomeToken =
  | { ok: true; address: Address; source: OutcomeTokenSource }
  | { ok: false; reason: string };

function asAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return null;
  if (!isAddress(trimmed)) return null;
  return trimmed as Address;
}

/**
 * MarketOnchain.outcomeToken is documented but can be missing at runtime.
 * Fall back to the protocol ERC-6909 singleton; never pass undefined into viem.
 */
export function resolveOutcomeTokenAddress(
  onchain: { outcomeToken?: unknown } | null | undefined,
): ResolvedOutcomeToken {
  const fromOnchain = asAddress(onchain?.outcomeToken);
  if (fromOnchain) {
    return { ok: true, address: fromOnchain, source: "onchain" };
  }
  if (isAddress(OUTCOME_TOKEN_6909)) {
    return {
      ok: true,
      address: OUTCOME_TOKEN_6909,
      source: "protocol_singleton",
    };
  }
  return { ok: false, reason: "No valid ERC-6909 outcome token address." };
}

export function parseOutcomeId(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

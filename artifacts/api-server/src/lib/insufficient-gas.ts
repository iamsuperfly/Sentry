/**
 * Classify genuine native-gas (STT) shortfalls vs unrelated execution failures.
 * Allowance, RPC, contract reverts, tUSDC, IOC misses, POST_ONLY, and param
 * errors must not match.
 */

const GAS_PATTERNS = [
  /insufficient funds/i,
  /insufficientfundserror/i,
  /insufficient stt/i,
  /exceeds the balance of the account/i,
  /insufficient native/i,
  /gas required exceeds allowance/i,
  /max fee per gas less than block base fee/i,
];

const UNRELATED_PATTERNS = [
  /erc-?20.?allowance/i,
  /token.?allowance/i,
  /collateral.?allowance/i,
  /insufficient.?allowance/i,
  /allowance too low/i,
  /needs.?approval/i,
  /\brpc\b/i,
  /json-rpc/i,
  /econnreset/i,
  /fetch failed/i,
  /readcontract/i,
  /chain_read_failed/i,
  /immediate\s*or\s*cancel/i,
  /immediateorcancelnofill/i,
  /postonlywouldcross/i,
  /post_only/i,
  /execution reverted/i,
  /contractrevert/i,
  /insufficient[_ ]tusdc/i,
  /insufficient[_ ]collateral/i,
  /insufficient[_ ]balance/i,
  /tusdc/i,
  /order already expired/i,
  /market_expiry/i,
  /invalid_tick/i,
  /invalid_lot/i,
  /book_stale/i,
  /no_usable_ask/i,
];

export function looksLikeInsufficientGas(
  code: string,
  reason?: string | null,
): boolean {
  const blob = `${code}\n${reason ?? ""}`;
  if (!GAS_PATTERNS.some((re) => re.test(blob))) return false;
  if (UNRELATED_PATTERNS.some((re) => re.test(blob))) return false;
  return true;
}

export function looksLikePostOnlyWouldCross(
  code: string,
  reason?: string | null,
): boolean {
  const blob = `${code}\n${reason ?? ""}`;
  return /postonlywouldcross/i.test(blob) || /post.?only would cross/i.test(blob);
}

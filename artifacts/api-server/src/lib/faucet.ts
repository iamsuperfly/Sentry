import { parseUnits } from "viem";

export const FAUCET_DAILY_LIMIT = "500";

export function parseFaucetAmount(raw: string): string {
  const value = raw.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(
      "Use a positive tUSDC amount with up to 6 decimal places, for example /faucet 25.",
    );
  }

  let units: bigint;
  try {
    units = parseUnits(value, 6);
  } catch {
    throw new Error("The faucet amount is invalid.");
  }

  if (units <= 0n || units > parseUnits(FAUCET_DAILY_LIMIT, 6)) {
    throw new Error(
      "The faucet amount must be greater than zero and no more than 500 tUSDC.",
    );
  }

  return value;
}

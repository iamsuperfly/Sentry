/**
 * Pure claimability rules. On-chain resolution + outcome-token balances
 * are authoritative; DB outcome is only a hint.
 */

export type ClaimResolution = {
  isResolved: boolean;
  isVoided: boolean;
  finalized: boolean;
  onchainStatus: number;
  winningOutcome: number | null;
};

export type ClaimBalances = {
  up: number;
  down: number;
};

export type ClaimDecision =
  | {
      action: "redeem";
      outcomeIdx: 0 | 1;
      balance: number;
      kind: "win" | "void";
      reason: string;
    }
  | {
      action: "skip";
      code:
        | "unresolved"
        | "already_claimed"
        | "losing_position"
        | "zero_balance"
        | "unknown_winner";
      reason: string;
      outcomeIdx?: 0 | 1;
      balance?: number;
    };

export const OUTCOME_UP = 0 as const;
export const OUTCOME_DOWN = 1 as const;

export function isMarketRedeemable(res: ClaimResolution): boolean {
  if (res.isVoided || res.onchainStatus === 5) return true;
  if (res.isResolved || res.onchainStatus === 4 || res.finalized) return true;
  return false;
}

export function decideClaim(input: {
  tradeStatus: string;
  resolution: ClaimResolution;
  balances: ClaimBalances;
  minBalance?: number;
}): ClaimDecision {
  if (input.tradeStatus === "redeemed") {
    return {
      action: "skip",
      code: "already_claimed",
      reason: "Trade is already marked redeemed.",
    };
  }
  if (!isMarketRedeemable(input.resolution)) {
    return {
      action: "skip",
      code: "unresolved",
      reason: "Market is not finalized/resolved on-chain.",
    };
  }

  const min = input.minBalance ?? 1e-9;
  const voided =
    input.resolution.isVoided || input.resolution.onchainStatus === 5;

  if (voided) {
    if (input.balances.up > min) {
      return {
        action: "redeem",
        outcomeIdx: OUTCOME_UP,
        balance: input.balances.up,
        kind: "void",
        reason: "Voided market: redeem UP at 0.5.",
      };
    }
    if (input.balances.down > min) {
      return {
        action: "redeem",
        outcomeIdx: OUTCOME_DOWN,
        balance: input.balances.down,
        kind: "void",
        reason: "Voided market: redeem DOWN at 0.5.",
      };
    }
    return {
      action: "skip",
      code: "already_claimed",
      reason: "Voided market but wallet outcome balances are zero.",
      balance: 0,
    };
  }

  const winner = input.resolution.winningOutcome;
  if (winner !== 0 && winner !== 1) {
    return {
      action: "skip",
      code: "unknown_winner",
      reason: "Resolved market has no parseable winningOutcome.",
    };
  }

  const winBal = winner === 0 ? input.balances.up : input.balances.down;
  const loseBal = winner === 0 ? input.balances.down : input.balances.up;
  if (winBal > min) {
    return {
      action: "redeem",
      outcomeIdx: winner,
      balance: winBal,
      kind: "win",
      reason: `Winning outcome ${winner} has redeemable balance ${winBal}.`,
    };
  }
  if (loseBal > min && winBal <= min) {
    return {
      action: "skip",
      code: "losing_position",
      reason: "Wallet holds only the losing outcome; payout is 0.",
      outcomeIdx: winner === 0 ? 1 : 0,
      balance: loseBal,
    };
  }
  return {
    action: "skip",
    code: "zero_balance",
    reason: "No outcome-token balance left to redeem.",
    outcomeIdx: winner,
    balance: 0,
  };
}

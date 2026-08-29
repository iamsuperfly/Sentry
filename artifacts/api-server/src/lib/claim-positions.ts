/**
 * /claim: scan settled trades, read on-chain resolution + ERC-6909 balances,
 * redeem winning (or void) balances via trader.redeem.
 */

import { parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.ts";
import { logger } from "./logger.ts";
import { decideClaim, type ClaimDecision } from "./claim-decision.ts";
import {
  exchangeFromConfig,
  onchainToLifecycle,
  rawToHuman,
} from "./resolved-market.ts";
import {
  parseOutcomeId,
  resolveOutcomeTokenAddress,
} from "./resolve-outcome-token.ts";
import { getSupabaseClient } from "./supabase.ts";
import { decryptPrivateKey } from "./wallet-crypto.ts";

export type ClaimableTradeRow = {
  id: string;
  userId: string;
  status: string;
  marketId: string;
  symbol: string;
  direction: string;
  stake: number;
  filledContracts: number | null;
  contracts: number | null;
};

export type ClaimAttempt = {
  tradeId: string;
  marketId: string;
  symbol: string;
  direction: string;
  status: "claimed" | "skipped" | "failed";
  code?: string;
  reason: string;
  outcomeIdx?: 0 | 1;
  outcomeBalance?: number;
  payoutEstimate?: number | null;
  transactionHash?: string;
};

function formatClaimLine(a: ClaimAttempt): string {
  const head = `${a.symbol} ${a.direction.toUpperCase()}`;
  const lines = [`${head}`, `   Status: ${a.status}`];
  if (a.payoutEstimate != null && a.status === "claimed") {
    lines.push(`   Payout: ${a.payoutEstimate} tUSDC`);
  }
  if (a.transactionHash) lines.push(`   Tx: ${a.transactionHash}`);
  if (a.status !== "claimed") lines.push(`   ${a.reason}`);
  return lines.join("\n");
}

export function formatClaimMessage(attempts: ClaimAttempt[]): string {
  if (attempts.length === 0) {
    return "No claimable positions found.";
  }
  const claimed = attempts.filter((a) => a.status === "claimed").length;
  const skipped = attempts.filter((a) => a.status === "skipped").length;
  return [
    "Claim scan",
    "",
    `Found: ${attempts.length} settled positions`,
    `Claimed: ${claimed}`,
    `Skipped: ${skipped}`,
    "",
    ...attempts.map((a, i) => `${i + 1}. ${formatClaimLine(a)}`),
  ].join("\n");
}

export async function listSettledTradesForClaim(
  config: AppConfig,
  userId: string,
  limit = 25,
): Promise<ClaimableTradeRow[]> {
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(
      "id, user_id, status, market_id, symbol, direction, stake_usdso, filled_contracts, contracts",
    )
    .eq("user_id", userId)
    .eq("status", "settled")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Unable to list settled trades for claim.");
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      id: String(r.id),
      userId: String(r.user_id),
      status: String(r.status),
      marketId: String(r.market_id),
      symbol: String(r.symbol ?? ""),
      direction: String(r.direction ?? ""),
      stake: Number(r.stake_usdso ?? 0),
      filledContracts: num(r.filled_contracts),
      contracts: num(r.contracts),
    };
  });
}

async function markTradeRedeemed(
  config: AppConfig,
  input: { tradeId: string; userId: string },
): Promise<void> {
  const { error } = await getSupabaseClient(config)
    .from("trades")
    .update({
      status: "redeemed",
      error_message: null,
    })
    .eq("id", input.tradeId)
    .eq("user_id", input.userId)
    .eq("status", "settled");
  if (error) throw new Error("Unable to mark trade redeemed.");
}

export async function runUserClaimScan(input: {
  config: AppConfig;
  userId: string;
  walletAddress: string;
  encryptedPrivateKey: string;
}): Promise<ClaimAttempt[]> {
  const trades = await listSettledTradesForClaim(input.config, input.userId);
  if (trades.length === 0) return [];

  const privateKey = decryptPrivateKey(input.config, input.encryptedPrivateKey);
  const exchange = exchangeFromConfig(input.config);
  const trader = exchange.client.createTrader({
    privateKey: privateKey as Hex,
  });
  const account = privateKeyToAccount(privateKey as Hex);

  const attempts: ClaimAttempt[] = [];
  try {
    for (const trade of trades) {
      try {
        const onchain = await exchange.client.getMarketOnchain(
          trade.marketId as Hex,
        );
        const token = resolveOutcomeTokenAddress(onchain);
        if (!token.ok) {
          attempts.push({
            tradeId: trade.id,
            marketId: trade.marketId,
            symbol: trade.symbol,
            direction: trade.direction,
            status: "failed",
            code: "missing_outcome_token",
            reason: token.reason,
          });
          continue;
        }
        const yesId = parseOutcomeId(
          (onchain as { yesId?: unknown }).yesId,
        );
        const noId = parseOutcomeId((onchain as { noId?: unknown }).noId);
        if (yesId === null || noId === null) {
          attempts.push({
            tradeId: trade.id,
            marketId: trade.marketId,
            symbol: trade.symbol,
            direction: trade.direction,
            status: "skipped",
            code: "missing_outcome_ids",
            reason: "On-chain yesId/noId missing; cannot read outcome balance.",
          });
          continue;
        }

        const lifecycle = onchainToLifecycle(trade.marketId, onchain);
        const decimals = onchain.decimals;
        const upRaw = await exchange.client.getOutcomeBalance(
          token.address,
          account.address,
          yesId,
        );
        const downRaw = await exchange.client.getOutcomeBalance(
          token.address,
          account.address,
          noId,
        );
        const balances = {
          up: rawToHuman(upRaw, decimals),
          down: rawToHuman(downRaw, decimals),
        };
        const decision: ClaimDecision = decideClaim({
          tradeStatus: trade.status,
          resolution: {
            isResolved: lifecycle.isResolved === true,
            isVoided: lifecycle.isVoided === true,
            finalized: lifecycle.finalized === true,
            onchainStatus: lifecycle.onchainStatus ?? 0,
            winningOutcome: lifecycle.winningOutcome ?? null,
          },
          balances,
        });

        logger.info(
          {
            tradeId: trade.id,
            marketId: trade.marketId,
            outcomeToken: token.address,
            outcomeTokenSource: token.source,
            outcomeIdx:
              decision.action === "redeem"
                ? decision.outcomeIdx
                : decision.outcomeIdx,
            outcomeBalance:
              decision.action === "redeem"
                ? decision.balance
                : decision.balance,
            claimStatus: decision.action,
            code: decision.action === "skip" ? decision.code : undefined,
          },
          "Claim decision",
        );

        if (decision.action === "skip") {
          attempts.push({
            tradeId: trade.id,
            marketId: trade.marketId,
            symbol: trade.symbol,
            direction: trade.direction,
            status: "skipped",
            code: decision.code,
            reason:
              decision.code === "losing_position"
                ? "Losing position"
                : decision.code === "already_claimed"
                  ? "Already redeemed"
                  : decision.reason,
            outcomeIdx: decision.outcomeIdx,
            outcomeBalance: decision.balance,
          });
          continue;
        }

        const amount = parseUnits(String(decision.balance), decimals);
        if (amount <= 0n) {
          attempts.push({
            tradeId: trade.id,
            marketId: trade.marketId,
            symbol: trade.symbol,
            direction: trade.direction,
            status: "skipped",
            code: "zero_balance",
            reason: "Redeem amount rounded to zero.",
            outcomeIdx: decision.outcomeIdx,
            outcomeBalance: decision.balance,
          });
          continue;
        }

        const result = await trader.redeem({
          marketId: trade.marketId as Hex,
          amount,
          outcomeIdx: decision.outcomeIdx,
        });
        await markTradeRedeemed(input.config, {
          tradeId: trade.id,
          userId: input.userId,
        });
        const payoutEstimate =
          decision.kind === "void" ? decision.balance * 0.5 : decision.balance;
        logger.info(
          {
            tradeId: trade.id,
            marketId: trade.marketId,
            outcomeIdx: decision.outcomeIdx,
            outcomeBalance: decision.balance,
            claimStatus: "claimed",
            txHash: result.hash,
          },
          "Claim redeem submitted",
        );
        attempts.push({
          tradeId: trade.id,
          marketId: trade.marketId,
          symbol: trade.symbol,
          direction: trade.direction,
          status: "claimed",
          reason: decision.reason,
          outcomeIdx: decision.outcomeIdx,
          outcomeBalance: decision.balance,
          payoutEstimate,
          transactionHash: result.hash,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 200) : "Claim failed.";
        attempts.push({
          tradeId: trade.id,
          marketId: trade.marketId,
          symbol: trade.symbol,
          direction: trade.direction,
          status: "failed",
          code: "claim_error",
          reason: message,
        });
      }
    }
  } finally {
    await Promise.race([
      exchange.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  return attempts;
}

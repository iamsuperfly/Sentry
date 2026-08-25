/**
 * Stage 6 — post-submission reconciliation.
 *
 * Recovers `submitted` (and uncertain) trades by observing chain receipts only.
 * Never places a new order. Never retries live submission from this path.
 */

import type { AppConfig } from "../config.ts";
import {
  canTransition,
  type IntentStatus,
} from "./execution.ts";

export const RECONCILIATION_MODULE = "stage-6-execution-reconciliation";

/** Trade row fields required for reconciliation. */
export type SubmittedTradeRow = {
  id: string;
  userId: string;
  status: IntentStatus;
  transactionHash: string | null;
  orderId: string | null;
  contracts: number;
  filledContracts: number | null;
  errorMessage: string | null;
};

/**
 * Observation of a previously submitted transaction — never a new broadcast.
 * Injected in production via RPC receipt lookup; tests use fixtures.
 */
export type ReceiptObservation =
  | { kind: "no_hash" }
  | { kind: "not_found"; transactionHash: string }
  | { kind: "pending"; transactionHash: string }
  | {
      kind: "reverted";
      transactionHash: string;
      reason?: string;
    }
  | {
      kind: "success";
      transactionHash: string;
      orderId?: string | null;
      /** Human-unit contracts filled (same scale as intent.contracts). */
      filledContracts: number;
    };

export type ReconcileDecision = {
  /** Next status, or null to leave the row unchanged (still submitted). */
  nextStatus: IntentStatus | null;
  /** Always false — reconciliation must never open a second order. */
  mayPlaceNewOrder: false;
  action:
    | "wait"
    | "stay_submitted_uncertain"
    | "mark_failed"
    | "mark_filled"
    | "mark_partially_filled";
  reason: string;
  transactionHash?: string;
  orderId?: string | null;
  filledContracts?: number;
};

/**
 * Pure classification of a receipt against a submitted trade.
 * Uncertain / missing receipts never authorize a new placement.
 */
export function classifyReceiptOutcome(input: {
  trade: Pick<
    SubmittedTradeRow,
    "status" | "transactionHash" | "contracts"
  >;
  observation: ReceiptObservation;
}): ReconcileDecision {
  const { trade, observation } = input;

  if (trade.status !== "submitted" && trade.status !== "partially_filled") {
    return {
      nextStatus: null,
      mayPlaceNewOrder: false,
      action: "wait",
      reason: `Trade status ${trade.status} is not eligible for post-submit reconciliation.`,
    };
  }

  switch (observation.kind) {
    case "no_hash":
      return {
        nextStatus: null,
        mayPlaceNewOrder: false,
        action: "stay_submitted_uncertain",
        reason:
          "No transaction hash recorded. Broadcast outcome is uncertain; do not place another order. Wait for manual/hash recovery or timeout policy.",
      };

    case "not_found":
      return {
        nextStatus: null,
        mayPlaceNewOrder: false,
        action: "wait",
        reason:
          "Transaction hash known but receipt not found yet. Keep status submitted; do not resubmit.",
        transactionHash: observation.transactionHash,
      };

    case "pending":
      return {
        nextStatus: null,
        mayPlaceNewOrder: false,
        action: "wait",
        reason:
          "Transaction is still pending inclusion. Keep status submitted; do not resubmit.",
        transactionHash: observation.transactionHash,
      };

    case "reverted":
      return {
        nextStatus: "failed",
        mayPlaceNewOrder: false,
        action: "mark_failed",
        reason:
          observation.reason?.slice(0, 240) ??
          "On-chain receipt status is reverted.",
        transactionHash: observation.transactionHash,
        filledContracts: 0,
      };

    case "success": {
      const filled = observation.filledContracts;
      if (!(filled > 0)) {
        return {
          nextStatus: "failed",
          mayPlaceNewOrder: false,
          action: "mark_failed",
          reason:
            "Receipt succeeded but filled quantity is zero (IOC cancelled / no liquidity).",
          transactionHash: observation.transactionHash,
          orderId: observation.orderId,
          filledContracts: 0,
        };
      }
      if (filled + 1e-12 >= trade.contracts) {
        return {
          nextStatus: "filled",
          mayPlaceNewOrder: false,
          action: "mark_filled",
          reason: "Receipt confirmed full fill.",
          transactionHash: observation.transactionHash,
          orderId: observation.orderId,
          filledContracts: filled,
        };
      }
      return {
        nextStatus: "partially_filled",
        mayPlaceNewOrder: false,
        action: "mark_partially_filled",
        reason: `Receipt confirmed partial fill (${filled} of ${trade.contracts}).`,
        transactionHash: observation.transactionHash,
        orderId: observation.orderId,
        filledContracts: filled,
      };
    }
  }
}

export type ReconcileDeps = {
  /**
   * Look up receipt / fill for an existing hash only.
   * Must not broadcast. Return `no_hash` when trade.transactionHash is null.
   */
  observeReceipt: (trade: SubmittedTradeRow) => Promise<ReceiptObservation>;
  updateTrade: (input: {
    tradeId: string;
    userId: string;
    status: IntentStatus;
    fromStatus?: IntentStatus;
    transactionHash?: string;
    orderId?: string;
    filledContracts?: number;
    errorMessage?: string | null;
  }) => Promise<void>;
};

export type ReconcileResult =
  | {
      ok: true;
      tradeId: string;
      action: ReconcileDecision["action"];
      status: IntentStatus;
      mayPlaceNewOrder: false;
      reason: string;
    }
  | {
      ok: false;
      tradeId: string;
      code: string;
      reason: string;
      mayPlaceNewOrder: false;
    };

/**
 * Reconcile one submitted/uncertain trade.
 * Idempotent with respect to terminal outcomes when fromStatus is enforced.
 */
export async function reconcileSubmittedTrade(input: {
  trade: SubmittedTradeRow;
  deps: ReconcileDeps;
}): Promise<ReconcileResult> {
  const { trade, deps } = input;

  if (trade.status !== "submitted" && trade.status !== "partially_filled") {
    return {
      ok: false,
      tradeId: trade.id,
      code: "not_reconcilable",
      reason: `Status ${trade.status} is not reconcilable.`,
      mayPlaceNewOrder: false,
    };
  }

  let observation: ReceiptObservation;
  try {
    observation = await deps.observeReceipt(trade);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 240)
        : "Receipt observation failed.";
    return {
      ok: false,
      tradeId: trade.id,
      code: "observe_failed",
      reason: message,
      mayPlaceNewOrder: false,
    };
  }

  const decision = classifyReceiptOutcome({ trade, observation });

  if (decision.mayPlaceNewOrder !== false) {
    return {
      ok: false,
      tradeId: trade.id,
      code: "invariant_violation",
      reason: "Reconciliation must never allow placing a new order.",
      mayPlaceNewOrder: false,
    };
  }

  if (decision.nextStatus === null) {
    // Annotate uncertain state without changing status when helpful.
    if (
      decision.action === "stay_submitted_uncertain" &&
      trade.status === "submitted"
    ) {
      const note =
        "uncertain_broadcast: no tx hash; reconciliation will not resubmit";
      if (!trade.errorMessage?.includes("uncertain_broadcast")) {
        try {
          await deps.updateTrade({
            tradeId: trade.id,
            userId: trade.userId,
            status: "submitted",
            fromStatus: "submitted",
            errorMessage: note,
          });
        } catch {
          // Non-fatal: status remains submitted either way.
        }
      }
    }

    return {
      ok: true,
      tradeId: trade.id,
      action: decision.action,
      status: trade.status,
      mayPlaceNewOrder: false,
      reason: decision.reason,
    };
  }

  if (!canTransition(trade.status, decision.nextStatus)) {
    return {
      ok: false,
      tradeId: trade.id,
      code: "illegal_transition",
      reason: `Illegal transition ${trade.status} → ${decision.nextStatus}.`,
      mayPlaceNewOrder: false,
    };
  }

  try {
    await deps.updateTrade({
      tradeId: trade.id,
      userId: trade.userId,
      status: decision.nextStatus,
      fromStatus: trade.status,
      transactionHash: decision.transactionHash,
      orderId: decision.orderId ?? undefined,
      filledContracts: decision.filledContracts,
      errorMessage:
        decision.nextStatus === "failed" ? decision.reason : null,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 240)
        : "Unable to update trade after reconciliation.";
    return {
      ok: false,
      tradeId: trade.id,
      code: "update_failed",
      reason: message,
      mayPlaceNewOrder: false,
    };
  }

  return {
    ok: true,
    tradeId: trade.id,
    action: decision.action,
    status: decision.nextStatus,
    mayPlaceNewOrder: false,
    reason: decision.reason,
  };
}

/**
 * Production helper: load submitted trades that still need resolution.
 * Does not touch the chain.
 */
export async function listTradesNeedingReconciliation(
  config: AppConfig,
  options?: { limit?: number },
): Promise<SubmittedTradeRow[]> {
  const { getSupabaseClient } = await import("./supabase.ts");
  const limit = options?.limit ?? 50;
  const { data, error } = await getSupabaseClient(config)
    .from("trades")
    .select(
      "id, user_id, status, transaction_hash, order_id, contracts, filled_contracts, error_message",
    )
    .in("status", ["submitted", "partially_filled"])
    .order("submitted_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error("Unable to list trades for reconciliation.");

  return (data ?? []).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    status: row.status as IntentStatus,
    transactionHash: (row.transaction_hash as string | null) ?? null,
    orderId: (row.order_id as string | null) ?? null,
    contracts: Number(row.contracts ?? 0),
    filledContracts:
      row.filled_contracts === null || row.filled_contracts === undefined
        ? null
        : Number(row.filled_contracts),
    errorMessage: (row.error_message as string | null) ?? null,
  }));
}

/**
 * Wire updateTradeExecution for reconciliation callers.
 * Lazy-imports supabase so pure classification tests need no DB deps.
 */
export function createReconciliationUpdateTrade(
  config: AppConfig,
): ReconcileDeps["updateTrade"] {
  return async (input) => {
    const { updateTradeExecution } = await import("./supabase.ts");
    await updateTradeExecution(config, {
      tradeId: input.tradeId,
      userId: input.userId,
      status: input.status,
      fromStatus: input.fromStatus,
      transactionHash: input.transactionHash,
      orderId: input.orderId,
      filledContracts: input.filledContracts,
      errorMessage: input.errorMessage,
    });
  };
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyReceiptOutcome,
  reconcileSubmittedTrade,
  type ReceiptObservation,
  type SubmittedTradeRow,
} from "./execution-reconciliation.ts";

function baseTrade(
  overrides: Partial<SubmittedTradeRow> = {},
): SubmittedTradeRow {
  return {
    id: "trade-1",
    userId: "user-1",
    status: "submitted",
    transactionHash: "0xabc",
    orderId: null,
    contracts: 10,
    filledContracts: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("classifyReceiptOutcome", () => {
  it("never allows placing a new order for any observation", () => {
    const observations: ReceiptObservation[] = [
      { kind: "no_hash" },
      { kind: "not_found", transactionHash: "0x1" },
      { kind: "pending", transactionHash: "0x1" },
      { kind: "reverted", transactionHash: "0x1" },
      { kind: "success", transactionHash: "0x1", filledContracts: 10 },
      { kind: "success", transactionHash: "0x1", filledContracts: 3 },
      { kind: "success", transactionHash: "0x1", filledContracts: 0 },
    ];
    for (const observation of observations) {
      const d = classifyReceiptOutcome({
        trade: baseTrade(),
        observation,
      });
      assert.equal(d.mayPlaceNewOrder, false);
    }
  });

  it("keeps submitted when hash is missing (uncertain broadcast)", () => {
    const d = classifyReceiptOutcome({
      trade: baseTrade({ transactionHash: null }),
      observation: { kind: "no_hash" },
    });
    assert.equal(d.nextStatus, null);
    assert.equal(d.action, "stay_submitted_uncertain");
  });

  it("waits when receipt is not found or pending", () => {
    for (const observation of [
      { kind: "not_found" as const, transactionHash: "0xabc" },
      { kind: "pending" as const, transactionHash: "0xabc" },
    ]) {
      const d = classifyReceiptOutcome({
        trade: baseTrade(),
        observation,
      });
      assert.equal(d.nextStatus, null);
      assert.equal(d.action, "wait");
    }
  });

  it("marks failed on reverted receipt", () => {
    const d = classifyReceiptOutcome({
      trade: baseTrade(),
      observation: { kind: "reverted", transactionHash: "0xabc", reason: "boom" },
    });
    assert.equal(d.nextStatus, "failed");
    assert.equal(d.action, "mark_failed");
  });

  it("marks filled on full success", () => {
    const d = classifyReceiptOutcome({
      trade: baseTrade(),
      observation: {
        kind: "success",
        transactionHash: "0xabc",
        orderId: "99",
        filledContracts: 10,
      },
    });
    assert.equal(d.nextStatus, "filled");
    assert.equal(d.action, "mark_filled");
    assert.equal(d.filledContracts, 10);
  });

  it("marks partially_filled on partial success", () => {
    const d = classifyReceiptOutcome({
      trade: baseTrade(),
      observation: {
        kind: "success",
        transactionHash: "0xabc",
        filledContracts: 4,
      },
    });
    assert.equal(d.nextStatus, "partially_filled");
    assert.equal(d.action, "mark_partially_filled");
  });

  it("marks failed when success has zero fill (IOC empty)", () => {
    const d = classifyReceiptOutcome({
      trade: baseTrade(),
      observation: {
        kind: "success",
        transactionHash: "0xabc",
        filledContracts: 0,
      },
    });
    assert.equal(d.nextStatus, "failed");
    assert.equal(d.action, "mark_failed");
  });
});

describe("reconcileSubmittedTrade", () => {
  it("updates to filled without ever calling a place-order path", async () => {
    const updates: Array<Record<string, unknown>> = [];
    let placeOrderCalled = false;

    const result = await reconcileSubmittedTrade({
      trade: baseTrade(),
      deps: {
        observeReceipt: async () => ({
          kind: "success",
          transactionHash: "0xabc",
          orderId: "7",
          filledContracts: 10,
        }),
        updateTrade: async (input) => {
          if ("placeOrder" in input) placeOrderCalled = true;
          updates.push(input);
        },
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, "filled");
      assert.equal(result.mayPlaceNewOrder, false);
      assert.equal(result.action, "mark_filled");
    }
    assert.equal(placeOrderCalled, false);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.status, "filled");
    assert.equal(updates[0]?.fromStatus, "submitted");
  });

  it("does not change status on uncertain no-hash; annotates error_message", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const result = await reconcileSubmittedTrade({
      trade: baseTrade({ transactionHash: null }),
      deps: {
        observeReceipt: async () => ({ kind: "no_hash" }),
        updateTrade: async (input) => {
          updates.push(input);
        },
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, "submitted");
      assert.equal(result.action, "stay_submitted_uncertain");
      assert.equal(result.mayPlaceNewOrder, false);
    }
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.status, "submitted");
    assert.match(String(updates[0]?.errorMessage), /uncertain_broadcast/);
  });

  it("marks failed on revert with fromStatus submitted", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const result = await reconcileSubmittedTrade({
      trade: baseTrade(),
      deps: {
        observeReceipt: async () => ({
          kind: "reverted",
          transactionHash: "0xabc",
          reason: "execution reverted",
        }),
        updateTrade: async (input) => {
          updates.push(input);
        },
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.status, "failed");
    assert.equal(updates[0]?.status, "failed");
    assert.equal(updates[0]?.fromStatus, "submitted");
  });

  it("waits without update when receipt not found", async () => {
    let updateCount = 0;
    const result = await reconcileSubmittedTrade({
      trade: baseTrade(),
      deps: {
        observeReceipt: async () => ({
          kind: "not_found",
          transactionHash: "0xabc",
        }),
        updateTrade: async () => {
          updateCount += 1;
        },
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.action, "wait");
      assert.equal(result.status, "submitted");
    }
    assert.equal(updateCount, 0);
  });

  it("rejects terminal statuses without allowing resubmit", async () => {
    const result = await reconcileSubmittedTrade({
      trade: baseTrade({ status: "failed" }),
      deps: {
        observeReceipt: async () => {
          throw new Error("should not observe");
        },
        updateTrade: async () => {
          throw new Error("should not update");
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "not_reconcilable");
      assert.equal(result.mayPlaceNewOrder, false);
    }
  });

  it("partially_filled can advance to filled", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const result = await reconcileSubmittedTrade({
      trade: baseTrade({
        status: "partially_filled",
        filledContracts: 4,
      }),
      deps: {
        observeReceipt: async () => ({
          kind: "success",
          transactionHash: "0xabc",
          filledContracts: 10,
        }),
        updateTrade: async (input) => {
          updates.push(input);
        },
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.status, "filled");
    assert.equal(updates[0]?.fromStatus, "partially_filled");
  });
});

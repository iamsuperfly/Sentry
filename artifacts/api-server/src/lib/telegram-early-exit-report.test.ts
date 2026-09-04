import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatFinalizationMessage } from "./telegram-trade-format.ts";
import { sanitizeTechnicalErrorNote } from "./telegram-user-errors.ts";

describe("early-exit user report", () => {
  it("does not treat a successful early-exit sell as an on-chain failure", () => {
    const note =
      "early-loss exit elapsed 91s sellTx=0xdeadbeefcafebabe0123456789abcdef";
    assert.equal(sanitizeTechnicalErrorNote(note), "Closed early to limit the loss.");
    const text = formatFinalizationMessage({
      symbol: "BTC",
      direction: "up",
      status: "cancelled",
      stake: 30,
      pnl: -16.2,
      tradingStart: 1_700_000_000,
      marketExpiry: 1_700_000_300,
      explorerTxBaseUrl: "https://shannon-explorer.somnia.network/tx",
      transactionHash: "0xabc",
      errorMessage: note,
    });
    assert.match(text, /CLOSED EARLY/);
    assert.match(text, /Closed early to limit the loss/);
    assert.doesNotMatch(text, /could not be completed on-chain/i);
    assert.doesNotMatch(text, /FAILED/);
  });
});

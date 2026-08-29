import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluatePreflightBook,
  levelFromBookSide,
} from "./preflight-book.ts";

describe("evaluatePreflightBook", () => {
  const book = {
    yesAsk: { price: 0.75, quantity: 50 },
    noAsk: { price: 0.25, quantity: 10 },
  };

  it("allows a valid fresh ask", () => {
    const r = evaluatePreflightBook({
      outcome: "YES",
      limitPrice: 0.75,
      contracts: 40,
      book,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.askPrice, 0.75);
      assert.equal(r.askQuantity, 50);
    }
  });

  it("skips missing ask", () => {
    const r = evaluatePreflightBook({
      outcome: "YES",
      limitPrice: 0.75,
      contracts: 10,
      book: { yesAsk: null, noAsk: book.noAsk },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "no_usable_ask");
  });

  it("skips insufficient liquidity", () => {
    const r = evaluatePreflightBook({
      outcome: "NO",
      limitPrice: 0.25,
      contracts: 20,
      book,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "insufficient_liquidity");
  });

  it("skips when live ask moved above limit", () => {
    const r = evaluatePreflightBook({
      outcome: "YES",
      limitPrice: 0.7,
      contracts: 10,
      book,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "book_stale");
  });

  it("parses raw book levels with decimals", () => {
    const ask = levelFromBookSide(
      [{ price: "750000", quantity: "40000000" }],
      6,
    );
    assert.deepEqual(ask, { price: 0.75, quantity: 40 });
  });
});

describe("preflight isolation", () => {
  it("one stale candidate does not change another valid result", () => {
    const a = evaluatePreflightBook({
      outcome: "YES",
      limitPrice: 0.75,
      contracts: 10,
      book: { yesAsk: { price: 0.75, quantity: 50 }, noAsk: null },
    });
    const b = evaluatePreflightBook({
      outcome: "NO",
      limitPrice: 0.8,
      contracts: 10,
      book: { yesAsk: null, noAsk: { price: 0.85, quantity: 50 } },
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.code, "book_stale");
  });
});

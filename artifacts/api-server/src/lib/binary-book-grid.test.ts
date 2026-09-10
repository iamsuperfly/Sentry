import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseBinaryBookGrid,
  snapBinaryAmount,
  snapBinaryPrice,
} from "./binary-book-grid.ts";

function grid6(tick = 1000n, lot = 1000n, min = 1000n) {
  const parsed = parseBinaryBookGrid({
    tickSizeRaw: tick,
    lotSizeRaw: lot,
    minQuantityRaw: min,
    decimals: 6,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("grid");
  return parsed.grid;
}

describe("binary book grid", () => {
  it("fails closed when params are missing", () => {
    const missing = parseBinaryBookGrid({
      tickSizeRaw: 0n,
      lotSizeRaw: 1000n,
      minQuantityRaw: 1000n,
      decimals: 6,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "book_params_unavailable");
  });

  it("snaps prices down onto tick and rejects zero amounts", () => {
    const grid = grid6(10_000n, 100_000n, 1_000n);
    const price = snapBinaryPrice(0.0512, grid);
    assert.equal(price.ok, true);
    if (price.ok) assert.equal(price.human, 0.05);

    const zero = snapBinaryAmount(0.0004, grid);
    assert.equal(zero.ok, false);
    if (!zero.ok) assert.equal(zero.code, "invalid_lot");
  });

  it("rejects amounts below minQuantity even when lot-aligned", () => {
    const grid = grid6(1_000n, 1_000n, 5_000n);
    const tooSmall = snapBinaryAmount(0.004, grid);
    assert.equal(tooSmall.ok, false);
  });
});

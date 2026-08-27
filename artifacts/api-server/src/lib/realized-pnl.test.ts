import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sumRealizedPnlValues } from "./realized-pnl.ts";

describe("sumRealizedPnlValues", () => {
  it("sums known pnl only", () => {
    assert.equal(
      sumRealizedPnlValues([{ pnl: 10 }, { pnl: null }, { pnl: -3 }, { pnl: undefined }]),
      7,
    );
  });
});

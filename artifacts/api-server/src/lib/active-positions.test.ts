import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countActivePositionsFromRows } from "./active-positions.ts";

describe("countActivePositionsFromRows", () => {
  const now = 1_700_000_000;

  it("counts only non-expired open statuses", () => {
    const n = countActivePositionsFromRows(
      [
        { status: "filled", marketExpiry: now + 300 },
        { status: "filled", marketExpiry: now - 10 },
        { status: "pending", marketExpiry: now + 60 },
        { status: "settled", marketExpiry: now + 300 },
      ],
      now,
    );
    assert.equal(n, 2);
  });

  it("keeps genuinely active pending/submitted/partial/filled", () => {
    const n = countActivePositionsFromRows(
      [
        { status: "pending", marketExpiry: now + 100 },
        { status: "submitted", marketExpiry: now + 100 },
        { status: "partially_filled", marketExpiry: now + 100 },
        { status: "filled", marketExpiry: now + 100 },
      ],
      now,
    );
    assert.equal(n, 4);
  });
});

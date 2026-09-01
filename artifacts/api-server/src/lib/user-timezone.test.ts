import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDateInZone,
  DEFAULT_USER_TIMEZONE,
  getZonedDayBounds,
  isInstantInLocalDay,
} from "./user-timezone.ts";

test("canonical zone is UTC", () => {
  assert.equal(DEFAULT_USER_TIMEZONE, "UTC");
});

test("UTC calendar day ignores caller zone argument", () => {
  const now = new Date("2026-08-31T23:30:00.000Z");
  assert.equal(calendarDateInZone(now, "Africa/Lagos"), "2026-08-31");
  assert.equal(calendarDateInZone(now, "UTC"), "2026-08-31");
});

test("UTC day bounds", () => {
  const now = new Date("2026-08-31T18:00:00.000Z");
  const bounds = getZonedDayBounds(now, "Africa/Lagos");
  assert.equal(bounds.localDate, "2026-08-31");
  assert.equal(bounds.start, "2026-08-31T00:00:00.000Z");
  assert.equal(bounds.end, "2026-09-01T00:00:00.000Z");
});

test("instant membership is UTC", () => {
  const now = new Date("2026-08-31T23:30:00.000Z");
  assert.equal(
    isInstantInLocalDay("2026-08-31T23:10:00.000Z", now, "Africa/Lagos"),
    true,
  );
});

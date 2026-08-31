import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDateInZone,
  DEFAULT_USER_TIMEZONE,
  getZonedDayBounds,
  isInstantInLocalDay,
  isValidIanaTimezone,
  normalizeTimezone,
} from "./user-timezone.ts";

test("default and invalid zones normalize to Africa/Lagos", () => {
  assert.equal(normalizeTimezone(null), DEFAULT_USER_TIMEZONE);
  assert.equal(normalizeTimezone("Not/AZone"), DEFAULT_USER_TIMEZONE);
  assert.equal(isValidIanaTimezone("Africa/Lagos"), true);
  assert.equal(isValidIanaTimezone("America/New_York"), true);
});

test("Lagos calendar day is UTC+1", () => {
  const now = new Date("2026-08-31T23:30:00.000Z");
  assert.equal(calendarDateInZone(now, "Africa/Lagos"), "2026-09-01");
  assert.equal(calendarDateInZone(now, "UTC"), "2026-08-31");
});

test("zoned day bounds for Africa/Lagos", () => {
  const now = new Date("2026-08-31T18:00:00.000Z");
  const bounds = getZonedDayBounds(now, "Africa/Lagos");
  assert.equal(bounds.localDate, "2026-08-31");
  assert.equal(bounds.start, "2026-08-30T23:00:00.000Z");
  assert.equal(bounds.end, "2026-08-31T23:00:00.000Z");
});

test("instant membership uses local day not UTC", () => {
  const now = new Date("2026-08-31T23:30:00.000Z");
  assert.equal(
    isInstantInLocalDay("2026-08-31T23:10:00.000Z", now, "Africa/Lagos"),
    true,
  );
  assert.equal(
    isInstantInLocalDay("2026-08-31T23:10:00.000Z", now, "UTC"),
    false,
  );
});

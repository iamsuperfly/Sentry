import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDateInZone,
  DEFAULT_USER_TIMEZONE,
  getZonedDayBounds,
  inferTimezoneFromTelegramLanguage,
  isInstantInLocalDay,
  isValidIanaTimezone,
  normalizeTimezone,
} from "./user-timezone.ts";

test("unknown zones fall back to UTC, not Africa/Lagos", () => {
  assert.equal(DEFAULT_USER_TIMEZONE, "UTC");
  assert.equal(normalizeTimezone(null), "UTC");
  assert.equal(normalizeTimezone("Not/AZone"), "UTC");
  assert.equal(isValidIanaTimezone("Africa/Lagos"), true);
  assert.equal(isValidIanaTimezone("America/New_York"), true);
});

test("Telegram language_code with region selects that region", () => {
  assert.equal(inferTimezoneFromTelegramLanguage("en-US"), "America/New_York");
  assert.equal(inferTimezoneFromTelegramLanguage("en-NG"), "Africa/Lagos");
  assert.equal(inferTimezoneFromTelegramLanguage("en-ng"), "Africa/Lagos");
  assert.equal(inferTimezoneFromTelegramLanguage("en-GB"), "Europe/London");
  assert.equal(inferTimezoneFromTelegramLanguage("pt-BR"), "America/Sao_Paulo");
});

test("bare English cannot imply Nigeria or the US", () => {
  assert.equal(inferTimezoneFromTelegramLanguage("en"), "UTC");
  assert.equal(inferTimezoneFromTelegramLanguage(null), "UTC");
  assert.equal(inferTimezoneFromTelegramLanguage(""), "UTC");
});

test("unambiguous language-only codes still map", () => {
  assert.equal(inferTimezoneFromTelegramLanguage("yo"), "Africa/Lagos");
  assert.equal(inferTimezoneFromTelegramLanguage("ja"), "Asia/Tokyo");
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

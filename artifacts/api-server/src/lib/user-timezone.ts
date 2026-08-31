/** IANA timezone helpers for user-local calendar days. */

export const DEFAULT_USER_TIMEZONE = "Africa/Lagos";

export function isValidIanaTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimezone(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_USER_TIMEZONE;
  return isValidIanaTimezone(value) ? value : DEFAULT_USER_TIMEZONE;
}

export function calendarDateInZone(
  now: Date,
  timeZone: string,
): string {
  const zone = normalizeTimezone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

/**
 * Inclusive start / exclusive end of the local calendar day, as UTC ISO strings.
 */
export function getZonedDayBounds(
  now: Date,
  timeZone: string,
): { start: string; end: string; localDate: string } {
  const zone = normalizeTimezone(timeZone);
  const localDate = calendarDateInZone(now, zone);
  const startMs = zonedMidnightUtcMs(localDate, zone);
  const [y, m, d] = localDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  // Adding one UTC calendar day is wrong across DST; walk until local date changes.
  let endMs = startMs + 36 * 60 * 60 * 1000;
  for (let offset = 20; offset <= 30; offset++) {
    const probe = new Date(startMs + offset * 60 * 60 * 1000);
    if (calendarDateInZone(probe, zone) !== localDate) {
      const probeDate = calendarDateInZone(probe, zone);
      endMs = zonedMidnightUtcMs(probeDate, zone);
      break;
    }
  }
  void nextDate;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    localDate,
  };
}

function zonedMidnightUtcMs(localDate: string, timeZone: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  let lo = Date.UTC(year, month - 1, day - 1, 0, 0, 0);
  let hi = Date.UTC(year, month - 1, day + 1, 12, 0, 0);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    const date = calendarDateInZone(new Date(mid), timeZone);
    if (date < localDate) lo = mid;
    else hi = mid;
  }
  while (calendarDateInZone(new Date(hi - 1000), timeZone) === localDate) {
    hi -= 1000;
  }
  while (calendarDateInZone(new Date(hi), timeZone) !== localDate) {
    hi += 1000;
  }
  return hi;
}

export function isInstantInLocalDay(
  iso: string | null,
  now: Date,
  timeZone: string,
): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const { start, end } = getZonedDayBounds(now, timeZone);
  return t >= Date.parse(start) && t < Date.parse(end);
}

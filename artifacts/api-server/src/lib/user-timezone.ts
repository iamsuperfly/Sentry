/** Canonical daily window is UTC midnight. Per-user timezones were removed. */

export const DEFAULT_USER_TIMEZONE = "UTC";

export function calendarDateInZone(
  now: Date,
  _timeZone: string = DEFAULT_USER_TIMEZONE,
): string {
  void _timeZone;
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getZonedDayBounds(
  now: Date,
  _timeZone: string = DEFAULT_USER_TIMEZONE,
): { start: string; end: string; localDate: string } {
  void _timeZone;
  const localDate = calendarDateInZone(now);
  const [y, m, d] = localDate.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    localDate,
  };
}

export function isInstantInLocalDay(
  iso: string | null,
  now: Date,
  _timeZone: string = DEFAULT_USER_TIMEZONE,
): boolean {
  void _timeZone;
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const { start, end } = getZonedDayBounds(now);
  return t >= Date.parse(start) && t < Date.parse(end);
}

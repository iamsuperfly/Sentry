/** IANA timezone helpers for user-local calendar days. */

/** Neutral fallback when Telegram does not expose a region. Not a product locale. */
export const DEFAULT_USER_TIMEZONE = "UTC";

const REGION_TIMEZONES: Record<string, string> = {
  NG: "Africa/Lagos",
  GH: "Africa/Accra",
  KE: "Africa/Nairobi",
  ZA: "Africa/Johannesburg",
  EG: "Africa/Cairo",
  US: "America/New_York",
  CA: "America/Toronto",
  MX: "America/Mexico_City",
  BR: "America/Sao_Paulo",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  DE: "Europe/Berlin",
  FR: "Europe/Paris",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  UA: "Europe/Kyiv",
  RU: "Europe/Moscow",
  TR: "Europe/Istanbul",
  IN: "Asia/Kolkata",
  PK: "Asia/Karachi",
  BD: "Asia/Dhaka",
  CN: "Asia/Shanghai",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  ID: "Asia/Jakarta",
  PH: "Asia/Manila",
  SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  AU: "Australia/Sydney",
  NZ: "Pacific/Auckland",
};

const LANGUAGE_TIMEZONES: Record<string, string> = {
  yo: "Africa/Lagos",
  ig: "Africa/Lagos",
  ha: "Africa/Lagos",
  ja: "Asia/Tokyo",
  ko: "Asia/Seoul",
  th: "Asia/Bangkok",
  vi: "Asia/Ho_Chi_Minh",
  uk: "Europe/Kyiv",
  ru: "Europe/Moscow",
  tr: "Europe/Istanbul",
  de: "Europe/Berlin",
  zh: "Asia/Shanghai",
};

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

/**
 * Best-effort timezone from Telegram User.language_code.
 * Telegram bots do not receive the device IANA timezone.
 * language_code is typically "en" or "en-US". Region tags can be mapped;
 * bare English cannot, so we fall back to UTC rather than a single country.
 */
export function inferTimezoneFromTelegramLanguage(
  languageCode: string | null | undefined,
): string {
  const raw = (languageCode ?? "").trim().replace(/_/g, "-");
  if (!raw) return DEFAULT_USER_TIMEZONE;
  const parts = raw.split("-").filter(Boolean);
  const language = parts[0]?.toLowerCase() ?? "";
  const region = [...parts].reverse().find((p) => /^[A-Za-z]{2}$/.test(p) && p === p.toUpperCase())
    ?? parts.find((p) => p.length === 2 && p === p.toUpperCase())
    ?? "";
  const regionNorm = region.toUpperCase();
  if (regionNorm && REGION_TIMEZONES[regionNorm]) {
    return REGION_TIMEZONES[regionNorm];
  }
  // Second tag is often region even when not all-caps in some clients (en-ng).
  if (parts[1] && parts[1].length === 2) {
    const maybe = parts[1].toUpperCase();
    if (REGION_TIMEZONES[maybe]) return REGION_TIMEZONES[maybe];
  }
  if (language && LANGUAGE_TIMEZONES[language]) {
    return LANGUAGE_TIMEZONES[language];
  }
  return DEFAULT_USER_TIMEZONE;
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

export function getZonedDayBounds(
  now: Date,
  timeZone: string,
): { start: string; end: string; localDate: string } {
  const zone = normalizeTimezone(timeZone);
  const localDate = calendarDateInZone(now, zone);
  const startMs = zonedMidnightUtcMs(localDate, zone);
  let endMs = startMs + 36 * 60 * 60 * 1000;
  for (let offset = 20; offset <= 30; offset++) {
    const probe = new Date(startMs + offset * 60 * 60 * 1000);
    if (calendarDateInZone(probe, zone) !== localDate) {
      const probeDate = calendarDateInZone(probe, zone);
      endMs = zonedMidnightUtcMs(probeDate, zone);
      break;
    }
  }
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

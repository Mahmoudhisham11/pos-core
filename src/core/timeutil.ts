export const utcnowIso = (now: Date = new Date()) => now.toISOString();

/** Parse the ISO strings stored in the DB (with 'Z', offsets, or naive = UTC). */
export function parseIso(value: unknown): Date | null {
  if (!value || typeof value !== "string") return null;
  let t = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += "T00:00:00Z";
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(t)) t += "Z";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

const cairoFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
/** YYYY-MM-DD in Africa/Cairo for an ISO timestamp (or a Date). */
export function cairoDateStr(value: unknown): string | null {
  const d = value instanceof Date ? value : parseIso(value);
  return d ? cairoFmt.format(d) : null;
}
/** True when `a` is strictly newer than `b` (unparseable values never win). */
export function isNewer(a: unknown, b: unknown): boolean {
  const da = parseIso(a), db = parseIso(b);
  return !!da && !!db && da.getTime() > db.getTime();
}

const cairoHourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", hour12: false });
/** The instant 23:59:59 Cairo time on the given YYYY-MM-DD (handles DST: UTC+3 or UTC+2). */
export function endOfCairoDay(day: string): Date {
  for (const off of [3, 2]) {
    const d = new Date(Date.parse(`${day}T23:59:59Z`) - off * 3600_000);
    if (cairoDateStr(d) === day && cairoHourFmt.format(d) === "23") return d;
  }
  return new Date(Date.parse(`${day}T21:59:59Z`));
}

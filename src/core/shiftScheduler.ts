import type { SqlDriver } from "../db/types";
import { serializeRow } from "../http/serialize";

export const CHECK_INTERVAL_MS = 60_000;

/** domain/shifts.closeStaleShifts: closes open invoices of earlier Cairo days and returns the created report rows. */
export type CloseStale = (db: SqlDriver, now: Date) => Array<Record<string, any>>;

/** Close all open invoices that belong to a day before today (Cairo). Safe to call at any time. */
export function performAutoCloseShift(db: SqlDriver, now: () => Date, closeStale: CloseStale): Array<Record<string, any>> {
  try {
    return db.transaction(() => closeStale(db, now()).map((r) => serializeRow(r)));
  } catch (e) {
    console.error("Error during auto-closing shift", e);
    return [];
  }
}

/** Every minute: close any shift whose Cairo day has ended (also catches up after the app was off). Returns a stop function. */
export function startShiftScheduler(db: SqlDriver, now: () => Date, closeStale: CloseStale, intervalMs = CHECK_INTERVAL_MS): () => void {
  performAutoCloseShift(db, now, closeStale);
  const t = setInterval(() => performAutoCloseShift(db, now, closeStale), intervalMs);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
}

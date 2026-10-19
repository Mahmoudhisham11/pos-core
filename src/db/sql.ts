import { ALIASES, serializeRow } from "../http/serialize";
import type { SqlDriver } from "./types";

/** table -> tables whose changes are mirrored to the cloud through the `sync_queue` outbox (users are pulled, never pushed). */
export const PUSHED_TABLES = new Set([
  "shop_products", "products", "transfers", "sales", "shift_reports", "sales_returns", "customers", "suppliers",
  "shop_purchases", "shop_purchase_returns", "employees", "employee_attendance", "employee_transactions",
  "expense_items", "monthly_expenses", "treasury_transactions", "stock_movements",
]);

export const nowIso = () => new Date().toISOString();

/** JSON-valued columns are stored as TEXT; booleans as 0/1. */
export function toDb(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

function enqueue(db: SqlDriver, table: string, recordId: string, action: "INSERT" | "UPDATE" | "DELETE", payload: unknown): void {
  db.run(
    `INSERT INTO "sync_queue" ("tableName","recordId","action","payload","status","createdAt") VALUES (?,?,?,?,'pending',?)`,
    [table, recordId, action, JSON.stringify(payload), nowIso()],
  );
}

/**
 * INSERT/UPDATE/DELETE helpers. For synced tables they also write the outbox row in the same transaction
 * (the Python backend did this with SQLAlchemy flush events) - ALWAYS use them instead of raw SQL for those tables.
 * Pass `{ skipSync: true }` when applying remote changes so they are not echoed back.
 */
export function insertRow(db: SqlDriver, table: string, row: Record<string, unknown>, opts: { skipSync?: boolean } = {}): void {
  const cols = Object.keys(row);
  db.run(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    cols.map((c) => toDb(row[c])),
  );
  if (!opts.skipSync && PUSHED_TABLES.has(table)) {
    const saved = db.get<any>(`SELECT * FROM "${table}" WHERE "id"=?`, [String(row.id)]);
    if (saved) enqueue(db, table, String(saved.id), "INSERT", serializeRow(saved));
  }
}
/**
 * Counters that several devices can change at the same time (stock, account balances). Their UPDATEs carry
 * `__deltas` ({field: change}) and the sync engine pushes them as Firestore increments, so two devices selling the
 * same product while offline end up with BOTH sales deducted instead of the last write overwriting the other.
 */
export const DELTA_FIELDS: Record<string, string[]> = {
  shop_products: ["quantity"],
  products: ["quantity"],
  customers: ["balance", "totalPurchases", "totalPaid", "remainingBalance"],
  suppliers: ["balance", "totalPurchases", "totalPaid", "remainingBalance"],
};

const deltaRound = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * `absolute` names counters this write SETS rather than moves (a stock-take: "there are X on the shelf now"). They are
 * left out of `__deltas`, so the sync engine uploads the value itself instead of an increment.
 */
export function updateRow(
  db: SqlDriver, table: string, id: string, patch: Record<string, unknown>,
  opts: { skipSync?: boolean; idCol?: string; absolute?: string[] } = {},
): void {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const idCol = opts.idCol ?? "id";
  const sync = !opts.skipSync && PUSHED_TABLES.has(table);
  const counters = sync ? DELTA_FIELDS[table] : undefined;
  const before = counters ? db.get<any>(`SELECT * FROM "${table}" WHERE "${idCol}"=?`, [id]) : undefined;
  db.run(`UPDATE "${table}" SET ${cols.map((c) => `"${c}"=?`).join(",")} WHERE "${idCol}"=?`, [...cols.map((c) => toDb(patch[c])), id]);
  if (sync) {
    const saved = db.get<any>(`SELECT * FROM "${table}" WHERE "${idCol}"=?`, [id]);
    if (!saved) return;
    const payload = serializeRow(saved);
    if (counters && before) {
      const deltas: Record<string, number> = {};
      for (const f of counters) {
        if (opts.absolute?.includes(f)) continue;
        const d = deltaRound(Number(saved[f] || 0) - Number(before[f] || 0));
        deltas[f] = d;
        for (const alias of ALIASES[f] ?? []) deltas[alias] = d; // the API aliases (e.g. stock) carry the same value
      }
      payload.__deltas = deltas;
      // unique id of this change: the cloud records it, so an increment re-sent after a lost acknowledgement is not
      // applied twice
      payload.__opId = crypto.randomUUID();
    }
    enqueue(db, table, String(saved.id), "UPDATE", payload);
  }
}
/**
 * Queues the row as it is now for upload WITHOUT moving any counter (all __deltas 0): used when this device holds
 * ledger entries the cloud copy lacks, so the merged ledger reaches the cloud (see api/sync.ts mergeLedgers).
 */
export function enqueueSnapshot(db: SqlDriver, table: string, id: string): void {
  if (!PUSHED_TABLES.has(table)) return;
  const saved = db.get<any>(`SELECT * FROM "${table}" WHERE "id"=?`, [id]);
  if (!saved) return;
  const payload = serializeRow(saved);
  const counters = DELTA_FIELDS[table];
  if (counters) {
    const deltas: Record<string, number> = {};
    for (const f of counters) {
      deltas[f] = 0;
      for (const alias of ALIASES[f] ?? []) deltas[alias] = 0;
    }
    payload.__deltas = deltas;
  }
  enqueue(db, table, String(saved.id), "UPDATE", payload);
}

export function deleteRow(db: SqlDriver, table: string, id: string, opts: { skipSync?: boolean } = {}): void {
  db.run(`DELETE FROM "${table}" WHERE "id"=?`, [id]);
  if (!opts.skipSync && PUSHED_TABLES.has(table)) enqueue(db, table, id, "DELETE", { id });
}
export const getById = <T = Record<string, any>>(db: SqlDriver, table: string, id: string, idCol = "id") =>
  db.get<T>(`SELECT * FROM "${table}" WHERE "${idCol}"=?`, [id]);
export const uid = () => crypto.randomUUID();
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

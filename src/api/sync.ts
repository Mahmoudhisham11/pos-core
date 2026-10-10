import { appException, requireAdmin } from "../core/auth";
import { hashPassword, isBcryptHash, verifyPassword } from "../core/security";
import { COLLECTION_TABLE_MAP, TABLE_COLLECTION_MAP } from "../core/syncHooks";
import { isNewer, utcnowIso } from "../core/timeutil";
import { Validator, validationFailed } from "../core/validation";
import { TABLE_COLUMNS, type ColumnMeta } from "../db/schema";
import { DELTA_FIELDS, deleteRow, enqueueSnapshot, getById, insertRow, updateRow } from "../db/sql";
import type { SqlDriver } from "../db/types";
import type { Router } from "../http/router";
import { assertSameShop } from "./cloud";

const CHUNK_SIZE = 25;

interface ApplyRemoteChange { collectionName: string; docId: string; action: string | null; data: Record<string, any> | null }

const count = (db: SqlDriver, table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`)!.n;

/** Python isoformat() of an aware UTC datetime (no fraction when it is zero). */
function pyIsoFromSeconds(seconds: number): string {
  const d = new Date(seconds * 1000);
  const iso = d.toISOString();
  const frac = iso.slice(19, 23); // ".123"
  const base = iso.slice(0, 19);
  return `${base}${frac === ".000" ? "" : frac + "000"}+00:00`;
}

/** Coerce Firestore values to the column's type (sanitize_val_for_column). */
export function sanitizeValForColumn(col: ColumnMeta, val: any): any {
  if (val === null || val === undefined) {
    if (!col.nullable) return col.type === "float" ? 0.0 : col.type === "int" ? 0 : "";
    return null;
  }
  // Firestore timestamps arrive as {seconds, nanoseconds}
  if (typeof val === "object" && !Array.isArray(val) && ("seconds" in val || val.type === "firestore/timestamp/1.0")) {
    const s = Number(val.seconds ?? 0);
    return Number.isFinite(s) ? pyIsoFromSeconds(s) : "";
  }
  if (col.type === "float") {
    const n = typeof val === "string" && val.trim() === "" ? NaN : Number(val);
    return Number.isFinite(n) ? n : 0.0;
  }
  if (col.type === "int") {
    const n = typeof val === "string" && val.trim() === "" ? NaN : Number(val);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (typeof val === "object") return JSON.stringify(val);
  if (typeof val === "boolean") return val ? "True" : "False";
  return String(val);
}

function pendingKeys(db: SqlDriver): Set<string> {
  const rows = db.all<{ tableName: string; recordId: string }>(`SELECT "tableName","recordId" FROM sync_queue WHERE status='pending'`);
  return new Set(rows.map((r) => `${r.tableName}\u0000${r.recordId}`));
}

type Outcome = "applied" | "skipped" | "ignored";

/** JSON ledger columns several devices append to: merged entry by entry (by id) instead of overwritten. */
export const LEDGER_FIELDS: Record<string, string[]> = {
  customers: ["transactions"],
  suppliers: ["transactions"],
  monthly_expenses: ["transactions", "expenses"],
};

const idList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim().startsWith("[")) { try { return (JSON.parse(v) as unknown[]).map(String); } catch { return []; } }
  return [];
};
const entries = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
};
const stamp = (e: any) => Date.parse(String(e?.date || e?.createdAt || "")) || 0;

/**
 * Union of the local and the incoming ledger entries (by id), minus every entry deleted on any device (voidedTxIds).
 * Returns true when the result has something the cloud copy lacks, i.e. this device must upload the merged ledger.
 */
function mergeLedgers(table: string, row: any, data: Record<string, any>, fields: Record<string, any>): boolean {
  const ledgerCols = LEDGER_FIELDS[table];
  if (!ledgerCols || !row) return false;
  const incomingVoided = idList(data.voidedTxIds);
  const voided = new Set([...idList(row.voidedTxIds), ...incomingVoided]);
  let cloudBehind = voided.size > new Set(incomingVoided).size;
  for (const col of ledgerCols) {
    const local = entries(row[col]);
    const incoming = col in data ? entries(data[col]) : local;
    const byId = new Map<string, any>();
    for (const e of [...local, ...incoming]) {
      const key = e && e.id !== undefined && e.id !== null ? String(e.id) : JSON.stringify(e);
      byId.set(key, e); // the incoming version of an entry wins (it was written later)
    }
    const merged = [...byId.entries()].filter(([k]) => !voided.has(k)).map(([, e]) => e).sort((a, b) => stamp(a) - stamp(b));
    const incomingLive = incoming.filter((e) => !voided.has(String(e?.id)));
    if (merged.length !== incomingLive.length) cloudBehind = true;
    fields[col] = JSON.stringify(merged);
  }
  fields.voidedTxIds = JSON.stringify([...voided]);
  if (table === "monthly_expenses") {
    // an expense record's amount is always the sum of its payments
    fields.amount = Math.round(entries(fields.transactions).reduce((t, e) => t + (Number(e?.amount) || 0), 0) * 100) / 100;
  }
  return cloudBehind;
}

/** Apply a single remote change. */
function applyOne(db: SqlDriver, item: ApplyRemoteChange, pending: Set<string>): Outcome {
  const table = COLLECTION_TABLE_MAP[item.collectionName];
  if (!table) return "ignored";
  const docId = String(item.docId);

  // Local edits that have not been pushed yet win over the cloud copy (they will be pushed next).
  if (pending.has(`${table}\u0000${docId}`)) return "skipped";

  const row = getById<any>(db, table, docId);

  if (item.action === "DELETE") {
    if (row) deleteRow(db, table, docId, { skipSync: true });
    return "applied";
  }

  const data = item.data ?? {};
  const incomingUpdated = data.updatedAt;
  // Local copy already newer. Not for counter tables: their cloud doc is the sum of every device's increments, so it
  // is always the truth once this device has nothing pending for the row (checked above).
  // Ledger tables are merged entry by entry instead (below), so an older copy can never drop newer entries either.
  if (row && incomingUpdated && !DELTA_FIELDS[table] && !LEDGER_FIELDS[table] && isNewer(row.updatedAt, incomingUpdated)) return "skipped";

  const now = utcnowIso();
  const cols = TABLE_COLUMNS[table]!;
  const fields: Record<string, any> = {};
  for (const col of cols) {
    if (col.name in data) fields[col.name] = sanitizeValForColumn(col, data[col.name]);
    else if (!row && !col.nullable && col.default !== undefined && col.name !== "id") fields[col.name] = col.default; // the model's own default
  }

  fields.id = docId;
  if (!fields.updatedAt && cols.some((c) => c.name === "updatedAt")) fields.updatedAt = incomingUpdated || now;

  if (table === "users") {
    delete fields.pin;
    const plain = fields.password;
    delete fields.password;
    if (plain) {
      if (isBcryptHash(plain)) fields.password = plain;
      else if (!row || !verifyPassword(plain, row.password)) fields.password = hashPassword(plain); // cloud copies written in clear text are re-hashed
    }
    if (!row && !("password" in fields)) fields.password = null; // cannot log in until an admin sets a password
  }

  if (row) {
    const cloudBehind = mergeLedgers(table, row, data, fields);
    const { id: _id, ...patch } = fields;
    updateRow(db, table, docId, patch, { skipSync: true });
    if (cloudBehind) enqueueSnapshot(db, table, docId); // upload what the cloud copy lacks (counters untouched)
  } else {
    insertRow(db, table, fields, { skipSync: true });
  }
  return "applied";
}

function markStates(db: SqlDriver, collections: Set<string>): void {
  const now = utcnowIso();
  for (const name of collections) {
    if (db.get(`SELECT 1 FROM sync_state WHERE "collectionName"=?`, [name])) {
      db.run(`UPDATE sync_state SET "lastSyncedAt"=?, status='synced' WHERE "collectionName"=?`, [now, name]);
    } else {
      db.run(`INSERT INTO sync_state ("collectionName","lastSyncedAt",status) VALUES (?,?,'synced')`, [name, now]);
    }
  }
}

/** Runs fn in a SAVEPOINT (the legacy code committed/rolled back per chunk on its own session). */
function savepoint<T>(db: SqlDriver, fn: () => T): T {
  db.exec("SAVEPOINT sync_chunk");
  try {
    const out = fn();
    db.exec("RELEASE sync_chunk");
    return out;
  } catch (e) {
    db.exec("ROLLBACK TO sync_chunk");
    db.exec("RELEASE sync_chunk");
    throw e;
  }
}

export function applyItems(db: SqlDriver, items: ApplyRemoteChange[]) {
  // remote changes must not be echoed back to the cloud: every write below uses skipSync
  const pending = pendingKeys(db);
  const counts: Record<Outcome, number> = { applied: 0, skipped: 0, ignored: 0 };
  const failed: Array<{ collectionName: string; docId: string; error: string }> = [];
  const touched = new Set<string>();

  for (let start = 0; start < items.length; start += CHUNK_SIZE) {
    const chunk = items.slice(start, start + CHUNK_SIZE);
    const snapshot = { ...counts };
    try {
      savepoint(db, () => {
        for (const it of chunk) {
          const outcome = applyOne(db, it, pending);
          counts[outcome]++;
          if (outcome === "applied") touched.add(it.collectionName);
        }
      });
    } catch {
      // Fast path failed: redo this chunk one document at a time so only the bad one is lost.
      Object.assign(counts, snapshot);
      for (const it of chunk) {
        try {
          const outcome = savepoint(db, () => applyOne(db, it, pending));
          counts[outcome]++;
          if (outcome === "applied") touched.add(it.collectionName);
        } catch (err) {
          console.warn(`Failed to apply ${it.collectionName}/${it.docId}:`, err);
          failed.push({ collectionName: it.collectionName, docId: String(it.docId), error: String(err instanceof Error ? err.message : err).slice(0, 200) });
        }
      }
    }
  }

  if (touched.size) markStates(db, touched);

  return {
    success: failed.length === 0,
    appliedCount: counts.applied,
    skippedCount: counts.skipped,
    failedCount: failed.length,
    failed: failed.slice(0, 50),
  };
}

function parseItem(v: Validator, raw: any, prefix: string): ApplyRemoteChange | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    v.push(prefix || "body", "Input should be a valid dictionary or object to extract fields from");
    return null;
  }
  const sub = new Validator();
  const collectionName = sub.str(raw, "collectionName", { required: true });
  const docId = sub.str(raw, "docId", { required: true });
  const action = sub.str(raw, "action");
  let data: Record<string, any> | null = null;
  if (raw.data !== undefined && raw.data !== null) {
    if (typeof raw.data === "object" && !Array.isArray(raw.data)) data = raw.data;
    else sub.push("data", "Input should be a valid dictionary");
  }
  for (const e of sub.errors) v.push((prefix ? prefix + " -> " : "") + e.field.replace(/^body -> /, ""), e.message);
  if (sub.errors.length) return null;
  return { collectionName: collectionName as string, docId: docId as string, action: action === undefined ? "SET" : action, data };
}

export function registerSync(router: Router): void {
  router.get("/sync/status", (ctx) => {
    const db = ctx.db;
    const states = db.all<{ collectionName: string; lastSyncedAt: string | null }>(`SELECT * FROM sync_state`);
    return {
      status: "ready",
      pendingCount: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_queue WHERE status='pending'`)!.n,
      collections: {
        shop_products: count(db, "shop_products"),
        products: count(db, "products"),
        sales: count(db, "sales"),
        shift_reports: count(db, "shift_reports"),
        customers: count(db, "customers"),
        suppliers: count(db, "suppliers"),
        employees: count(db, "employees"),
        monthly_expenses: count(db, "monthly_expenses"),
        treasury_transactions: count(db, "treasury_transactions"),
      },
      lastSynced: Object.fromEntries(states.map((s) => [s.collectionName, s.lastSyncedAt])),
      timestamp: utcnowIso(ctx.now()),
    };
  });

  // Sync is driven by the client (it owns the Firestore connection); this reports what is waiting.
  router.post("/sync/trigger", (ctx) => {
    const pending = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_queue WHERE status='pending'`)!.n;
    return { success: true, pendingCount: pending, message: "المزامنة تعمل من واجهة التطبيق" };
  }, { write: false });

  router.get("/sync/queue", (ctx) => {
    assertSameShop(ctx.db, ctx.query.shopId);
    const v = new Validator("query");
    const limit = v.int(ctx.query, "limit", { ge: 1, le: 1000 }) ?? 200;
    v.done();
    const items = ctx.db.all<any>(`SELECT * FROM sync_queue WHERE status='pending' ORDER BY id ASC LIMIT ?`, [limit]);
    return items.map((it) => {
      let payload: any = it.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { /* keep the raw text */ }
      }
      return {
        id: it.id,
        tableName: it.tableName,
        collectionName: TABLE_COLLECTION_MAP[it.tableName] ?? it.tableName,
        recordId: it.recordId,
        action: it.action,
        payload,
        createdAt: it.createdAt,
      };
    });
  });

  router.post("/sync/queue/mark-synced", (ctx) => {
    assertSameShop(ctx.db, ctx.body?.shopId);
    const v = new Validator();
    const rawIds = ctx.body?.ids;
    let ids: number[] = [];
    if (rawIds !== undefined && rawIds !== null) {
      if (!Array.isArray(rawIds)) v.push("ids", "Input should be a valid list");
      else rawIds.forEach((x: unknown, i: number) => {
        if (typeof x === "number" && Number.isInteger(x)) ids.push(x);
        else if (typeof x === "string" && /^\s*[+-]?\d+\s*$/.test(x)) ids.push(parseInt(x, 10));
        else v.push(`ids -> ${i}`, "Input should be a valid integer, unable to parse string as an integer");
      });
    }
    const single = v.int(ctx.body, "id");
    v.done();
    if (!ids.length) ids = single != null ? [single] : [];
    let removed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      removed += ctx.db.run(`DELETE FROM sync_queue WHERE id IN (${part.map(() => "?").join(",")})`, part).changes;
    }
    return { success: true, removedCount: removed };
  });

  router.post("/sync/apply", (ctx) => {
    assertSameShop(ctx.db, ctx.body?.shopId);
    const v = new Validator();
    const item = parseItem(v, ctx.body, "");
    v.done();
    if (!item) throw validationFailed([]);
    if (!(item.collectionName in COLLECTION_TABLE_MAP)) {
      throw appException(400, `Collection ${item.collectionName} not recognized`, "VALIDATION_ERROR");
    }
    const result = applyItems(ctx.db, [item]);
    return { ...result, action: item.action === "DELETE" ? "DELETED" : "SET", id: String(item.docId) };
  });

  router.post("/sync/apply-batch", (ctx) => {
    assertSameShop(ctx.db, ctx.body?.shopId);
    const v = new Validator();
    const raw = ctx.body?.items;
    const items: ApplyRemoteChange[] = [];
    if (raw === undefined) v.push("items", "Field required");
    else if (!Array.isArray(raw)) v.push("items", "Input should be a valid list");
    else raw.forEach((r: unknown, i: number) => { const it = parseItem(v, r, `items -> ${i}`); if (it) items.push(it); });
    v.done();
    return applyItems(ctx.db, items);
  });

  router.post("/sync/purge-tables", (ctx) => {
    requireAdmin(ctx);
    const v = new Validator();
    const confirm = v.str(ctx.body, "confirm") ?? "";
    const keepUsers = v.bool(ctx.body, "keepUsers");
    v.done();
    // Admin-only wipe of local business data. Requires {"confirm": "PURGE"}; users are kept by default.
    if (confirm !== "PURGE") throw appException(400, 'للتأكيد أرسل {"confirm": "PURGE"}', "CONFIRMATION_REQUIRED");
    const purged: Record<string, number> = {};
    for (const tbl of PURGE_ORDER) {
      if (tbl === "users" && (keepUsers ?? true)) continue;
      purged[tbl] = ctx.db.run(`DELETE FROM "${tbl}"`).changes; // table names come from the constant list above
    }
    return { success: true, purged };
  });
}

const PURGE_ORDER = [
  "sync_queue", "sync_state", "employee_transactions", "employee_attendance", "employees", "shop_purchase_returns",
  "shop_purchases", "sales_returns", "shift_reports", "sales", "transfers", "shop_products", "products",
  "treasury_transactions", "monthly_expenses", "expense_items", "customers", "suppliers", "users",
];

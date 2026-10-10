/**
 * Versioned schema migrations for the unified SQLite schema (port of db/migrations.py + db/seed.py).
 *
 * `createSchema` creates missing *tables*, but never alters existing ones, so every column added after a database
 * was first created needs an explicit, ordered step here. Steps are idempotent and recorded in `schema_version`;
 * a failing step aborts startup instead of being swallowed.
 */
import { hashPassword, isBcryptHash } from "../core/security";
import { createSchema } from "./schema";
import type { SqlDriver } from "./types";

const columns = (db: SqlDriver, table: string): Set<string> =>
  new Set(db.all<{ name: string }>(`PRAGMA table_info('${table}')`).map((r) => r.name));

function addColumn(db: SqlDriver, table: string, column: string, ddlType: string): void {
  if (!columns(db, table).has(column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${ddlType}`);
}

function v1CustomerTypeAndShiftLink(db: SqlDriver): void {
  addColumn(db, "customers", "type", "VARCHAR(50) DEFAULT 'قطاعي'");
  addColumn(db, "sales", "shiftReportId", "VARCHAR(100)");
  db.exec(`CREATE INDEX IF NOT EXISTS "ix_sales_shiftReportId" ON "sales" ("shiftReportId")`);
}

function v2HashPlaintextPasswords(db: SqlDriver): void {
  const rows = db.all<{ id: string; password: string }>(`SELECT id, password FROM users WHERE password IS NOT NULL`);
  for (const { id, password } of rows) {
    if (password && !isBcryptHash(password)) db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashPassword(password), id]);
  }
  // PINs were stored (and shipped to the cloud) in clear text and nothing authenticates with them.
  db.run(`UPDATE users SET pin = NULL WHERE pin IS NOT NULL`);
}

/** The shop / branch an account belongs to (typed at sign-up or set by the admin). */
function v3UserBranch(db: SqlDriver): void {
  addColumn(db, "users", "branch", "VARCHAR(150)");
}

/** Device-level facts about this database, e.g. which cloud shop it belongs to (see core/cloudAccount). */
function v4AppMeta(db: SqlDriver): void {
  db.exec(`CREATE TABLE IF NOT EXISTS "app_meta" ("key" VARCHAR(100) NOT NULL PRIMARY KEY, "value" TEXT)`);
}

/** How much money a sales return handed back, and through which payment method (see domain/cashflow). */
function v5ReturnCashRefund(db: SqlDriver): void {
  addColumn(db, "sales_returns", "cashRefund", "FLOAT");
  addColumn(db, "sales_returns", "refundMethod", "VARCHAR(50)");
}

/** Ids of ledger entries deleted on some device, so the entry-by-entry merge of synced ledgers never brings them back. */
function v6VoidedTxIds(db: SqlDriver): void {
  for (const t of ["customers", "suppliers", "monthly_expenses"]) addColumn(db, t, "voidedTxIds", "TEXT");
}

export const MIGRATIONS: Array<[number, string, (db: SqlDriver) => void]> = [
  [1, "v1_customer_type_and_shift_link", v1CustomerTypeAndShiftLink],
  [2, "v2_hash_plaintext_passwords", v2HashPlaintextPasswords],
  [3, "v3_user_branch", v3UserBranch],
  [4, "v4_app_meta", v4AppMeta],
  [5, "v5_return_cash_refund", v5ReturnCashRefund],
  [6, "v6_voided_tx_ids", v6VoidedTxIds],
];

/** Housekeeping: revoked tokens past their expiry and idempotency keys older than a week. */
export function purgeExpiredRecords(db: SqlDriver, now: Date): void {
  const nowIso = now.toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  db.transaction(() => {
    db.run(`DELETE FROM revoked_tokens WHERE "expiresAt" < ?`, [nowIso]);
    db.run(`DELETE FROM idempotency_keys WHERE "createdAt" < ?`, [weekAgo]);
  });
}

/** Creates/upgrades the schema and returns the schema version. No default accounts are seeded (seed.py was a no-op). */
export function runMigrations(db: SqlDriver, now: Date = new Date()): number {
  createSchema(db);
  let current = 0;
  db.transaction(() => {
    const row = db.get<{ version: number }>(`SELECT version FROM schema_version WHERE id = 1`);
    current = row ? row.version : 0;
    if (!row) db.run(`INSERT INTO schema_version (id, version) VALUES (1, 0)`);
    for (const [version, , step] of MIGRATIONS) {
      if (version <= current) continue;
      step(db);
      db.run(`UPDATE schema_version SET version = ? WHERE id = 1`, [version]);
      current = version;
    }
  });
  purgeExpiredRecords(db, now);
  return current;
}

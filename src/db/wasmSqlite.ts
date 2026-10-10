import type { SqlDriver } from "./types";

/** Minimal shape of the @sqlite.org/sqlite-wasm oo1.DB we rely on (kept structural so the Backend has no hard dependency on it). */
export interface WasmDb {
  exec(opts: string | { sql: string; bind?: unknown[]; rowMode?: "object"; returnValue?: "resultRows" }): any;
  selectObject(sql: string, bind?: unknown[] | undefined): Record<string, unknown> | undefined;
  changes(): number;
}

/** SqlDriver over SQLite WASM. Used inside a Web Worker, where the OPFS-backed database is synchronous. */
export function wrapWasmSqlite(db: WasmDb): SqlDriver {
  let depth = 0;
  // sqlite-wasm refuses an empty bind array on a statement without parameters, so pass none at all.
  const bind = (p?: unknown[]) => !p || p.length === 0 ? undefined : p.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v));
  return {
    exec: (sql) => void db.exec(sql),
    run(sql, params = []) {
      db.exec({ sql, bind: bind(params) });
      return { changes: db.changes() };
    },
    get: <T>(sql: string, params: unknown[] = []) => db.selectObject(sql, bind(params)) as T | undefined,
    all: <T>(sql: string, params: unknown[] = []) =>
      db.exec({ sql, bind: bind(params), rowMode: "object", returnValue: "resultRows" }) as T[],
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

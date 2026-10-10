import Database from "better-sqlite3";
import type { SqlDriver } from "./types";

export function openBetterSqlite(path: string): SqlDriver & { close(): void } {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  let depth = 0;
  return {
    close: () => db.close(),
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => ({ changes: db.prepare(sql).run(...(params as never[])).changes }),
    get: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) as T | undefined,
    all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      try {
        return db.transaction(fn)();
      } finally {
        depth--;
      }
    },
  };
}

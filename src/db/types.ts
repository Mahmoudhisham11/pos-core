/**
 * Minimal synchronous SQL driver. The same core runs on:
 *  - desktop: better-sqlite3 (a real file in APPDATA)
 *  - web: SQLite WASM inside a Web Worker (OPFS)
 * Both are synchronous inside their own thread, so the core stays synchronous.
 */
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number };
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  /** Runs fn atomically; rolls back if it throws. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;
}

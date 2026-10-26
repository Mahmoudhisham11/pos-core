/**
 * Node-only entry (`@devora/pos-core/node`): the better-sqlite3 driver. Kept out of the main entry so browser bundles
 * (SQLite WASM in a Web Worker) never pull in the native module.
 */
export { openBetterSqlite } from "./db/betterSqlite";

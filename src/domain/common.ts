import type { SqlDriver } from "../db/types";
import { updateRow } from "../db/sql";
import { HttpError, badRequest } from "../http/errors";

export { badRequest };

export const EPS = 1e-9;

/** Half-up rounding on the shortest decimal repr (what Python's Decimal(str(x)).quantize does), so 1.005 -> 1.01. */
function roundHalfUp(value: unknown, places: number): number {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const s = value.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return 0;
    n = Number(s);
  } else if (!value) return 0;
  else return 0; // booleans / objects: Decimal(str(..)) raises in Python -> 0.0
  if (!n || !Number.isFinite(n)) return 0;
  const neg = n < 0;
  const abs = Math.abs(n);
  const s = String(abs);
  if (s.includes("e")) return abs < 1 ? 0 : (neg ? -abs : abs);
  const [ip, fp = ""] = s.split(".");
  const frac = fp.padEnd(places + 1, "0");
  let scaled = BigInt(ip + frac.slice(0, places));
  if (frac.charCodeAt(places) >= 53) scaled += 1n; // next digit >= 5
  const out = Number(scaled) / 10 ** places;
  return neg ? -out : out;
}
export const money = (value: unknown): number => roundHalfUp(value, 2);
export const qtyRound = (value: unknown): number => roundHalfUp(value, 3);

/** Python `str(float)`: integral values keep a trailing ".0" (used in user-facing ledger notes). */
export function pyStr(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return n.toFixed(1);
  return String(n);
}
/** Python `format(x, "g")`. */
export function fmtG(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6 || abs < 1e-4) {
    const [m = "", e = "0"] = n.toExponential(5).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const ex = Number(e);
    return `${mant}e${ex < 0 ? "-" : "+"}${String(Math.abs(ex)).padStart(2, "0")}`;
  }
  return String(Number(n.toPrecision(6)));
}

export const dumps = (value: unknown): string => JSON.stringify(value);

export function loadsList(raw: unknown): Record<string, any>[] {
  const isObj = (x: unknown) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (Array.isArray(raw)) return raw.filter(isObj);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data.filter(isObj);
    } catch { /* not JSON */ }
  }
  return [];
}

export function loadsDict(raw: unknown): Record<string, any> | null {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const data = JSON.parse(raw);
      return data !== null && typeof data === "object" && !Array.isArray(data) ? data : null;
    } catch { return null; }
  }
  return null;
}

/** Columns that hold embedded objects (customer, cashier, ...) are stored as JSON text. */
export function jsonField(value: unknown): string {
  if (value !== null && typeof value === "object") return dumps(value);
  return value ? String(value) : "";
}

export const newId = (): string => crypto.randomUUID();

export function docNumber(prefix: string, today: string): string {
  return `${prefix}-${today.replace(/-/g, "")}-${100000 + Math.floor(Math.random() * 900000)}`; // 6 digits: no clashes between devices
}

/** Python truthiness (empty list/dict are falsy, unlike JS). */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

export function itemKeyMatches(a: Record<string, any>, b: Record<string, any>): boolean {
  const s = (v: unknown) => (v ? String(v) : "");
  const aBar = s(a.barcode).trim(), bBar = s(b.barcode).trim();
  if (aBar && bBar) return aBar === bBar;
  const aId = s(a.productId || a.product_id || a.id), bId = s(b.productId || b.product_id || b.id);
  if (aId && bId) return aId === bId;
  const aName = s(a.name || a.productName).trim().toLowerCase(), bName = s(b.name || b.productName).trim().toLowerCase();
  return !!(aName && bName && aName === bName);
}

/** Look a product up by barcode, then id, then exact (case-insensitive) name. `table` is "shop_products" or "products". */
export function findProduct(db: SqlDriver, table: string, barcode?: string | null, pid?: string | null, name?: string | null): any | undefined {
  const bc = (barcode || "").trim();
  if (bc) {
    const found = db.get<any>(`SELECT * FROM "${table}" WHERE "barcode"=? LIMIT 1`, [bc]);
    if (found) return found;
  }
  if (pid) {
    const found = db.get<any>(`SELECT * FROM "${table}" WHERE "id"=?`, [String(pid)]);
    if (found) return found;
  }
  const nm = (name || "").trim().toLowerCase();
  if (nm) return db.get<any>(`SELECT * FROM "${table}" WHERE lower("name")=? LIMIT 1`, [nm]);
  return undefined;
}
export const findShopProduct = (db: SqlDriver, barcode?: string | null, pid?: string | null, name?: string | null) =>
  findProduct(db, "shop_products", barcode, pid, name);
export const findWarehouseProduct = (db: SqlDriver, barcode?: string | null, pid?: string | null, name?: string | null) =>
  findProduct(db, "products", barcode, pid, name);

/**
 * Persist a row object mutated in memory (the stand-in for SQLAlchemy's unit of work): writes every column except `id`,
 * going through updateRow so the sync outbox sees it.
 */
export function saveRow(db: SqlDriver, table: string, row: Record<string, any>): void {
  const { id, ...patch } = row;
  updateRow(db, table, String(id), patch);
}

// ---------------------------------------------------------------------------
// Request validation (stand-in for the pydantic "Loose" models)
// ---------------------------------------------------------------------------
/** Pydantic `Loose.ALIASES`: copy snake_case input keys onto their camelCase field when that one is absent. */
export function applyAliases(data: Record<string, any>, aliases: Record<string, string>): Record<string, any> {
  const out = { ...data };
  for (const [snake, camel] of Object.entries(aliases)) {
    if (snake in out && !(camel in out)) out[camel] = out[snake];
  }
  return out;
}

export interface FieldError { field: string; message: string }

/** Collects pydantic-style errors; `field` is the " -> " joined loc like FastAPI's handler produces. */
export class Validator {
  errors: FieldError[] = [];
  add(loc: Array<string | number>, message: string) { this.errors.push({ field: ["body", ...loc].join(" -> "), message }); }
  /** Number coercion as pydantic lax mode (numeric strings accepted). Returns undefined if invalid (error recorded). */
  num(loc: Array<string | number>, v: unknown, opts: { gt?: number; ge?: number } = {}): number | undefined {
    let n: number | undefined;
    if (typeof v === "number" && Number.isFinite(v)) n = v;
    else if (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(v)) n = Number(v);
    else if (typeof v === "boolean") n = v ? 1 : 0;
    if (n === undefined) { this.add(loc, "Input should be a valid number"); return undefined; }
    if (opts.gt !== undefined && !(n > opts.gt)) { this.add(loc, `Input should be greater than ${opts.gt}`); return undefined; }
    if (opts.ge !== undefined && !(n >= opts.ge)) { this.add(loc, `Input should be greater than or equal to ${opts.ge}`); return undefined; }
    return n;
  }
  str(loc: Array<string | number>, v: unknown): string | undefined {
    if (typeof v === "string") return v;
    this.add(loc, "Input should be a valid string");
    return undefined;
  }
  throwIfAny(): void {
    if (this.errors.length) {
      throw new HttpError(422, { error_code: "VALIDATION_ERROR", message: "Request validation failed", errors: this.errors });
    }
  }
}

export function validationError(errors: FieldError[]): HttpError {
  return new HttpError(422, { error_code: "VALIDATION_ERROR", message: "Request validation failed", errors });
}

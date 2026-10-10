// Small Python-compat helpers shared by the parties endpoints (customers/suppliers/employees/expenses/treasury).
import { HttpError } from "../http/errors";
import type { Ctx } from "../http/types";

/** domain/common.money: round half-up (away from zero) to 2 decimals; unparseable -> 0. */
export function money(value: unknown): number {
  if (!value) return 0;
  const n = typeof value === "number" ? value : typeof value === "string" ? (value.trim() === "" ? NaN : Number(value)) : Number(value);
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(Number((Math.abs(n) * 100).toPrecision(15))) / 100;
  return n < 0 ? -r : r;
}

export const dumps = (v: unknown): string => JSON.stringify(v);

/** A JSON list of ids (e.g. voidedTxIds) as strings. */
export function loadsIds(raw: unknown): string[] {
  let a: unknown = raw;
  if (typeof raw === "string") { try { a = JSON.parse(raw); } catch { return []; } }
  return Array.isArray(a) ? a.filter((x) => x !== null && x !== undefined).map(String) : [];
}

export function loadsList(raw: unknown): Record<string, any>[] {
  const keep = (a: unknown[]) => a.filter((x): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x));
  if (Array.isArray(raw)) return keep(raw);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const d = JSON.parse(raw);
      if (Array.isArray(d)) return keep(d);
    } catch { /* fall through */ }
  }
  return [];
}

/** Columns holding embedded objects are stored as JSON text. */
export function jsonField(v: unknown): string {
  if (v !== null && typeof v === "object") return dumps(v);
  return v ? String(v) : "";
}

/** Python `str(x)` for JSON-decoded values. */
export function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Python `float(x)`: raises (-> 500 in the legacy app) on garbage. */
export function pyFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new Error(`could not convert to float: ${pyStr(v)}`);
}

/** Python `int(x)`. */
export function pyInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new Error(`invalid literal for int(): ${pyStr(v)}`);
}

/** dict.get(key, default): the default applies only when the key is absent. */
export const getKey = (d: Record<string, any>, k: string, def: unknown = null) => (k in d ? d[k] : def);
/** Python `data.get(a) or data.get(b)`. */
export interface FieldError { field: string; message: string }
export function validationError(errors: FieldError[]): HttpError {
  return new HttpError(422, { error_code: "VALIDATION_ERROR", message: "Request validation failed", errors });
}

/** FastAPI Query(default, ge, le) for integer params. */
export function intQuery(ctx: Ctx, name: string, def: number, ge: number, le: number): number {
  const raw = ctx.query[name];
  if (raw === undefined || raw === "") return def;
  if (!/^[+-]?\d+$/.test(raw.trim())) throw validationError([{ field: name, message: "Input should be a valid integer" }]);
  const n = parseInt(raw, 10);
  if (n < ge) throw validationError([{ field: name, message: `Input should be greater than or equal to ${ge}` }]);
  if (n > le) throw validationError([{ field: name, message: `Input should be less than or equal to ${le}` }]);
  return n;
}

/** Validators for pydantic-style optional fields; push into `errors`, return the coerced value. */
export class Validator {
  errors: FieldError[] = [];
  constructor(private body: any) {}
  err(field: string, message: string) { this.errors.push({ field, message }); }
  str(field: string, o: { required?: boolean; min?: number; max?: number } = {}): string | null | undefined {
    const v = this.body[field];
    if (v === undefined || v === null) {
      if (o.required) this.err(field, "Field required");
      return v;
    }
    if (typeof v !== "string") { this.err(field, "Input should be a valid string"); return undefined; }
    if (o.min !== undefined && v.length < o.min) this.err(field, `String should have at least ${o.min} character${o.min === 1 ? "" : "s"}`);
    if (o.max !== undefined && v.length > o.max) this.err(field, `String should have at most ${o.max} characters`);
    return v;
  }
  num(field: string, o: { required?: boolean; gt?: number; ge?: number; le?: number } = {}): number | null | undefined {
    const v = this.body[field];
    if (v === undefined || v === null) {
      if (o.required) this.err(field, "Field required");
      return v;
    }
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (typeof v === "boolean" || !Number.isFinite(n)) { this.err(field, "Input should be a valid number"); return undefined; }
    if (o.gt !== undefined && !(n > o.gt)) this.err(field, `Input should be greater than ${o.gt}`);
    if (o.ge !== undefined && !(n >= o.ge)) this.err(field, `Input should be greater than or equal to ${o.ge}`);
    if (o.le !== undefined && !(n <= o.le)) this.err(field, `Input should be less than or equal to ${o.le}`);
    return n;
  }
  /** Optional list of dicts. */
  dictList(field: string): Record<string, any>[] | null | undefined {
    const v = this.body[field];
    if (v === undefined || v === null) return v;
    if (!Array.isArray(v) || v.some((x) => !x || typeof x !== "object" || Array.isArray(x))) {
      this.err(field, "Input should be a valid list of objects");
      return undefined;
    }
    return v;
  }
  done() { if (this.errors.length) throw validationError(this.errors); }
}

/** Request bodies declared as `Dict[str, Any]` / pydantic models must be JSON objects. */
export function bodyObject(ctx: Ctx): Record<string, any> {
  const b = ctx.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw validationError([{ field: "body", message: "Input should be a valid dictionary" }]);
  return b;
}

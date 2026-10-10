/** Product catalogue operations shared by the shop (`shop_products`) and warehouse (`products`) tables. */
import type { SqlDriver } from "../db/types";
import { getById, insertRow, updateRow } from "../db/sql";
import { HttpError, badRequest } from "../http/errors";
import { money, newId, qtyRound } from "./common";

// ---------------------------------------------------------------------------
// Pydantic-style request validation (422 body identical to the legacy handler)
// ---------------------------------------------------------------------------
export class Validation {
  errors: { field: string; message: string }[] = [];
  constructor(public loc: string[] = ["body"]) {}
  add(path: (string | number)[], message: string) {
    this.errors.push({ field: [...this.loc, ...path].join(" -> "), message });
  }
  /** Throws the legacy 422 when any field failed. */
  check() {
    if (this.errors.length) {
      throw new HttpError(422, { error_code: "VALIDATION_ERROR", message: "Request validation failed", errors: this.errors });
    }
  }
}

export const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Optional[float] field: undefined/null -> null. Returns undefined when invalid (error recorded). */
export function floatField(v: Validation, raw: Record<string, any>, name: string, o: { ge?: number; gt?: number; required?: boolean; path?: (string | number)[] } = {}): number | null | undefined {
  const p = [...(o.path ?? []), name];
  const val = raw[name];
  if (val === undefined || val === null) {
    if (o.required) { v.add(p, "Field required"); return undefined; }
    return null;
  }
  let n: number;
  if (typeof val === "number") n = val;
  else if (typeof val === "boolean") n = val ? 1 : 0;
  else if (typeof val === "string") {
    const s = val.trim();
    if (!NUM_RE.test(s)) { v.add(p, "Input should be a valid number, unable to parse string as a number"); return undefined; }
    n = Number(s);
  } else { v.add(p, "Input should be a valid number"); return undefined; }
  if (o.ge !== undefined && n < o.ge) { v.add(p, `Input should be greater than or equal to ${o.ge}`); return undefined; }
  if (o.gt !== undefined && !(n > o.gt)) { v.add(p, `Input should be greater than ${o.gt}`); return undefined; }
  return n;
}

export function intField(v: Validation, raw: Record<string, any>, name: string, o: { ge?: number } = {}): number | null | undefined {
  const val = raw[name];
  if (val === undefined || val === null) return null;
  let n: number;
  if (typeof val === "number") {
    if (!Number.isInteger(val)) { v.add([name], "Input should be a valid integer, got a number with a fractional part"); return undefined; }
    n = val;
  } else if (typeof val === "string" && /^\s*[+-]?\d+\s*$/.test(val)) n = Number(val.trim());
  else if (typeof val === "string") { v.add([name], "Input should be a valid integer, unable to parse string as an integer"); return undefined; }
  else { v.add([name], "Input should be a valid integer"); return undefined; }
  if (o.ge !== undefined && n < o.ge) { v.add([name], `Input should be greater than or equal to ${o.ge}`); return undefined; }
  return n;
}

/** Optional[str] (or required str with length limits). Returns `def` when absent/null for optional fields. */
export function strField(v: Validation, raw: Record<string, any>, name: string, o: { def?: string | null; required?: boolean; min?: number; max?: number; path?: (string | number)[] } = {}): string | null | undefined {
  const p = [...(o.path ?? []), name];
  const val = raw[name];
  if (val === undefined || (val === null && o.required)) {
    if (o.required) { v.add(p, "Field required"); return undefined; }
    return o.def ?? null;
  }
  if (val === null) return null; // explicit null overrides the default (Optional[str])
  if (typeof val !== "string") { v.add(p, "Input should be a valid string"); return undefined; }
  if (o.min !== undefined && val.length < o.min) { v.add(p, `String should have at least ${o.min} character${o.min === 1 ? "" : "s"}`); return undefined; }
  if (o.max !== undefined && val.length > o.max) { v.add(p, `String should have at most ${o.max} characters`); return undefined; }
  return val;
}

export function boolField(v: Validation, raw: Record<string, any>, name: string, def: boolean): boolean | null | undefined {
  const val = raw[name];
  if (val === undefined) return def;
  if (val === null) return null;
  if (typeof val === "boolean") return val;
  if (val === 0 || val === 1) return val === 1;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (["1", "true", "t", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "f", "no", "n", "off"].includes(s)) return false;
  }
  v.add([name], "Input should be a valid boolean, unable to interpret input");
  return undefined;
}

/** Pydantic `model_dump(exclude_none=True)`: declared fields first (in order), then the extras. */
export function dumpModel(declared: string[], parsed: Record<string, any>, raw: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of declared) if (parsed[f] !== undefined && parsed[f] !== null) out[f] = parsed[f];
  for (const [k, val] of Object.entries(raw)) if (!declared.includes(k) && val !== null && val !== undefined) out[k] = val;
  return out;
}

/** Body of a request model must be a JSON object. */
export function bodyObject(body: unknown): Record<string, any> {
  if (!isObj(body)) {
    const v = new Validation();
    v.add([], "Input should be a valid dictionary or object to extract fields from");
    v.check();
  }
  return body as Record<string, any>;
}

// ---------------------------------------------------------------------------
// ProductIn
// ---------------------------------------------------------------------------
export interface ProductIn {
  barcode: string | null; name: string; category: string | null; brand: string | null;
  quantity: number | null; costPrice: number | null; wholesalePrice: number | null; sellingPrice: number | null;
  price: number | null; minThreshold: number | null; description: string | null;
}

export function parseProductIn(body: unknown): ProductIn {
  const raw = bodyObject(body);
  const v = new Validation();
  const out = {
    barcode: strField(v, raw, "barcode", { def: "" }),
    name: strField(v, raw, "name", { required: true, min: 1, max: 255 }),
    category: strField(v, raw, "category", { def: "أخرى" }),
    brand: strField(v, raw, "brand", { def: "Nelly" }),
    quantity: raw.quantity === undefined ? 0 : floatField(v, raw, "quantity", { ge: 0 }),
    costPrice: raw.costPrice === undefined ? 0 : floatField(v, raw, "costPrice", { ge: 0 }),
    wholesalePrice: raw.wholesalePrice === undefined ? 0 : floatField(v, raw, "wholesalePrice", { ge: 0 }),
    sellingPrice: raw.sellingPrice === undefined ? 0 : floatField(v, raw, "sellingPrice", { ge: 0 }),
    price: floatField(v, raw, "price", { ge: 0 }),
    minThreshold: intField(v, raw, "minThreshold", { ge: 0 }),
    description: strField(v, raw, "description", { def: "" }),
  };
  v.check();
  return out as ProductIn;
}

type ProductTable = "products" | "shop_products";

function barcodeTaken(db: SqlDriver, table: ProductTable, barcode: string, excludeId?: string): boolean {
  if (!barcode) return false;
  const row = excludeId
    ? db.get(`SELECT id FROM "${table}" WHERE barcode=? AND id!=?`, [barcode, excludeId])
    : db.get(`SELECT id FROM "${table}" WHERE barcode=?`, [barcode]);
  return row !== undefined && row !== null;
}

/** Create a product, or add stock to the existing product that already owns this barcode. Returns the saved row. */
export function addOrRestock(db: SqlDriver, table: ProductTable, data: ProductIn, defaultThreshold: number, now: string): Record<string, any> {
  const cost = data.costPrice || data.wholesalePrice || 0.0;
  const wholesale = data.wholesalePrice || cost || 0.0;
  const sell = data.price !== null && data.price !== undefined ? data.price : (data.sellingPrice || 0.0);
  const barcode = (data.barcode || "").trim();

  if (barcode) {
    const existing = db.get<any>(`SELECT * FROM "${table}" WHERE barcode=? LIMIT 1`, [barcode]);
    if (existing) {
      const patch: Record<string, unknown> = { quantity: qtyRound((existing.quantity || 0) + Number(data.quantity || 0)) };
      if (cost > 0) {
        patch.costPrice = money(cost);
        patch.wholesalePrice = money(wholesale);
      }
      if (sell > 0) patch.sellingPrice = money(sell);
      patch.updatedAt = now;
      updateRow(db, table, existing.id, patch);
      return getById(db, table, existing.id)!;
    }
  }

  const id = newId();
  insertRow(db, table, {
    id,
    barcode,
    name: data.name.trim(),
    category: data.category || "أخرى",
    brand: data.brand || "Nelly",
    quantity: qtyRound(data.quantity || 0),
    costPrice: money(cost),
    wholesalePrice: money(wholesale),
    sellingPrice: money(sell),
    minThreshold: data.minThreshold !== null && data.minThreshold !== undefined ? data.minThreshold : defaultThreshold,
    description: data.description || "",
    createdAt: now,
    updatedAt: now,
  });
  return getById(db, table, id)!;
}

/** Python `str(x)` for scalars. */
const pyScalarStr = (x: unknown): string => (x === true ? "True" : x === false ? "False" : String(x));

/** Python `float(x)`; throws on anything it would reject. */
function pyToFloat(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "string") {
    const s = x.trim();
    if (NUM_RE.test(s)) return Number(s);
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(s)) return NaN;
  }
  throw new Error("not a float");
}

function num(data: Record<string, any>, keys: string[], minimum = 0.0): number | null {
  for (const k of keys) {
    if (data[k] !== undefined && data[k] !== null) {
      let val: number;
      try { val = pyToFloat(data[k]); } catch { throw badRequest(`قيمة غير صالحة للحقل ${k}`, "VALIDATION_ERROR"); }
      if (val < minimum) throw badRequest(`القيمة في الحقل ${k} لا يمكن أن تكون سالبة`, "VALIDATION_ERROR");
      return val;
    }
  }
  return null;
}

const has = (d: Record<string, any>, k: string) => d[k] !== undefined && d[k] !== null;

/** Partial update from a free-form body (PUT/PATCH share it). */
export function applyUpdate(db: SqlDriver, table: ProductTable, prod: Record<string, any>, data: Record<string, any>, now: string): void {
  const p: Record<string, any> = { ...prod };
  if (has(data, "name")) {
    const name = pyScalarStr(data.name).trim();
    if (!name) throw badRequest("اسم الصنف مطلوب", "VALIDATION_ERROR");
    p.name = name;
  }
  if (has(data, "barcode")) {
    const barcode = pyScalarStr(data.barcode).trim();
    if (barcodeTaken(db, table, barcode, prod.id)) {
      throw new HttpError(409, { error_code: "DUPLICATE_BARCODE", message: "الباركود مستخدم لصنف آخر", details: {} });
    }
    p.barcode = barcode;
  }
  if (has(data, "category")) p.category = pyScalarStr(data.category);
  if (has(data, "brand")) p.brand = pyScalarStr(data.brand);

  const qty = num(data, ["quantity", "stock"]);
  if (qty !== null) p.quantity = qtyRound(qty);

  const cost = num(data, ["costPrice", "cost_price"]);
  if (cost !== null) {
    p.costPrice = money(cost);
    if (!p.wholesalePrice) p.wholesalePrice = money(cost);
  }
  const wholesale = num(data, ["wholesalePrice", "wholesale_price"]);
  if (wholesale !== null) {
    p.wholesalePrice = money(wholesale);
    if (!p.costPrice) p.costPrice = money(wholesale);
  }
  const sell = num(data, ["sellingPrice", "selling_price", "price"]);
  if (sell !== null) p.sellingPrice = money(sell);
  const threshold = num(data, ["minThreshold"]);
  if (threshold !== null) p.minThreshold = Math.trunc(threshold);
  if (has(data, "description")) p.description = pyScalarStr(data.description);

  p.updatedAt = now;
  const { id: _id, ...patch } = p;
  updateRow(db, table, prod.id, patch);
}

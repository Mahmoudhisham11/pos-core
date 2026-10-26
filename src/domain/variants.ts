/**
 * Product variants (size / colour / material ...).
 *
 * Every variant is a complete product row (own barcode, quantity, prices) in `shop_products` or `products`; the
 * variants of one model share `groupId`. Because sales, returns, purchases, transfers, stock-takes, the movement log
 * and cloud sync all work per product row, they handle variants without knowing about them.
 *
 * Columns: groupId (model id), groupName (model name), variantLabel ("أسود / L"), attributes (JSON object).
 * A variant's `name` is always `groupName - variantLabel`, so receipts, reports and searches show the full name.
 */
import { settings } from "../core/config";
import type { SqlDriver } from "../db/types";
import { deleteRow, getById, insertRow, updateRow } from "../db/sql";
import { HttpError, badRequest } from "../http/errors";
import { serializeList } from "../http/serialize";
import { Validation, bodyObject, boolField, floatField, intField, isObj, strField } from "./catalog";
import { loadsDict, money, newId, qtyRound } from "./common";
import { logMovement, type ProductTable } from "./stock";

export type Attributes = Record<string, string>;

export interface OptionIn { name: string; values: string[] }

export interface VariantIn {
  attributes: Attributes;
  barcode: string;
  quantity: number;
  costPrice: number | null;
  wholesalePrice: number | null;
  sellingPrice: number | null;
  minThreshold: number | null;
  description: string | null;
}

export interface GroupIn {
  name: string;
  category: string | null;
  brand: string | null;
  description: string | null;
  costPrice: number | null;
  wholesalePrice: number | null;
  sellingPrice: number | null;
  minThreshold: number | null;
  options: OptionIn[] | null;
  variants: VariantIn[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clean = (x: unknown): string => (x === null || x === undefined ? "" : String(x)).trim();

/** Attribute object from a request or a stored row (JSON text). Keys and values are trimmed strings; empty ones dropped. */
export function normalizeAttributes(raw: unknown): Attributes | null {
  const obj = isObj(raw) ? raw : loadsDict(raw);
  if (!obj) return null;
  const out: Attributes = {};
  for (const [k, val] of Object.entries(obj)) {
    const key = clean(k), value = clean(val);
    if (key && value && (typeof val === "string" || typeof val === "number")) out[key] = value;
  }
  return out;
}

/** Order-independent identity of an attribute combination (duplicate detection inside a group). */
export const attributesKey = (a: Attributes): string =>
  JSON.stringify(Object.keys(a).sort().map((k) => [k.toLowerCase(), a[k]!.toLowerCase()]));

/** "أسود / L": values in option order, then any remaining keys in their own order. */
export function variantLabelOf(a: Attributes, order: string[] = []): string {
  const keys = [...order.filter((k) => k in a), ...Object.keys(a).filter((k) => !order.includes(k))];
  return keys.map((k) => a[k]).join(" / ");
}

export const variantName = (groupName: string, label: string): string => (label ? `${groupName} - ${label}` : groupName);

/** All combinations of the option values (cartesian product), as attribute objects in option order. */
export function combinations(options: OptionIn[]): Attributes[] {
  let out: Attributes[] = [{}];
  for (const o of options) out = out.flatMap((a) => o.values.map((val) => ({ ...a, [o.name]: val })));
  return options.length ? out : [];
}

/**
 * Variant columns to copy onto a product created from a document line (sale return, purchase, transfer), so a
 * variant re-created elsewhere stays in its group. Empty when the source is not a variant.
 */
export function variantFields(src: Record<string, any> | null | undefined): Record<string, any> {
  if (!src || !clean(src.groupId)) return {};
  const attributes = normalizeAttributes(src.attributes) ?? {};
  return {
    groupId: clean(src.groupId),
    groupName: clean(src.groupName) || null,
    variantLabel: clean(src.variantLabel) || variantLabelOf(attributes),
    attributes,
  };
}

/** Option list (name + distinct values, in first-seen order) derived from the variants of a group. */
function optionsOf(rows: Array<Record<string, any>>): OptionIn[] {
  const map = new Map<string, string[]>();
  for (const r of rows) {
    for (const [k, val] of Object.entries(normalizeAttributes(r.attributes) ?? {})) {
      const list = map.get(k) ?? (map.set(k, []), map.get(k)!);
      if (!list.includes(val)) list.push(val);
    }
  }
  return [...map].map(([name, values]) => ({ name, values }));
}

function barcodeOwner(db: SqlDriver, table: ProductTable, barcode: string): Record<string, any> | undefined {
  if (!barcode) return undefined;
  return db.get<any>(`SELECT id, name FROM "${table}" WHERE barcode=? LIMIT 1`, [barcode]);
}

const duplicateBarcode = (barcode: string, owner?: string) =>
  new HttpError(409, {
    error_code: "DUPLICATE_BARCODE",
    message: owner ? `الباركود ${barcode} مستخدم للصنف: ${owner}` : `الباركود ${barcode} متكرر في نفس الطلب`,
    details: { barcode },
  });

const duplicateVariant = (label: string) =>
  new HttpError(409, { error_code: "DUPLICATE_VARIANT", message: `الاختيار "${label}" موجود بالفعل في نفس الموديل`, details: { variantLabel: label } });

const groupNotFound = () => new HttpError(404, { error_code: "GROUP_NOT_FOUND", message: "الموديل غير موجود", details: {} });

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------
function parseOptions(v: Validation, raw: unknown): OptionIn[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) { v.add(["options"], "Input should be a valid list"); return null; }
  const out: OptionIn[] = [];
  raw.forEach((o, i) => {
    if (!isObj(o)) { v.add(["options", i], "Input should be a valid dictionary"); return; }
    const name = clean(o.name);
    if (!name) { v.add(["options", i, "name"], "Field required"); return; }
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) { v.add(["options", i, "name"], "Duplicate option name"); return; }
    if (!Array.isArray(o.values)) { v.add(["options", i, "values"], "Input should be a valid list"); return; }
    const values: string[] = [];
    for (const x of o.values) {
      const s = clean(x);
      if (s && !values.some((y) => y.toLowerCase() === s.toLowerCase())) values.push(s);
    }
    if (!values.length) { v.add(["options", i, "values"], "List should have at least 1 item"); return; }
    out.push({ name, values });
  });
  return out;
}

function parseVariant(v: Validation, raw: unknown, path: (string | number)[]): VariantIn | null {
  if (!isObj(raw)) { v.add(path, "Input should be a valid dictionary"); return null; }
  const attributes = normalizeAttributes(raw.attributes);
  if (!attributes || !Object.keys(attributes).length) { v.add([...path, "attributes"], "At least one attribute is required, e.g. {\"المقاس\": \"L\"}"); }
  const n = (name: string) => floatField(v, raw, name, { ge: 0, path });
  const threshold = raw.minThreshold === undefined || raw.minThreshold === null ? null : n("minThreshold");
  const out: VariantIn = {
    attributes: attributes ?? {},
    barcode: clean(strField(v, raw, "barcode", { def: "", path }) ?? ""),
    quantity: raw.quantity === undefined || raw.quantity === null ? 0 : (n("quantity") ?? 0),
    costPrice: n("costPrice") ?? null,
    wholesalePrice: n("wholesalePrice") ?? null,
    sellingPrice: n("sellingPrice") ?? n("price") ?? null,
    minThreshold: threshold === null || threshold === undefined ? null : Math.trunc(threshold),
    description: strField(v, raw, "description", { path }) ?? null,
  };
  return attributes ? out : null;
}

function parseVariants(v: Validation, raw: unknown): VariantIn[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) { v.add(["variants"], "Input should be a valid list"); return null; }
  const out: VariantIn[] = [];
  raw.forEach((r, i) => { const p = parseVariant(v, r, ["variants", i]); if (p) out.push(p); });
  return out;
}

export function parseGroupIn(body: unknown): GroupIn {
  const raw = bodyObject(body);
  const v = new Validation();
  const out: GroupIn = {
    name: clean(strField(v, raw, "name", { required: true, min: 1, max: 255 })),
    category: strField(v, raw, "category", { def: settings.DEFAULT_CATEGORY }) ?? null,
    brand: strField(v, raw, "brand", { def: settings.DEFAULT_BRAND }) ?? null,
    description: strField(v, raw, "description", { def: "" }) ?? null,
    costPrice: floatField(v, raw, "costPrice", { ge: 0 }) ?? null,
    wholesalePrice: floatField(v, raw, "wholesalePrice", { ge: 0 }) ?? null,
    sellingPrice: floatField(v, raw, "sellingPrice", { ge: 0 }) ?? floatField(v, raw, "price", { ge: 0 }) ?? null,
    minThreshold: intField(v, raw, "minThreshold", { ge: 0 }) ?? null,
    options: parseOptions(v, raw.options),
    variants: parseVariants(v, raw.variants),
  };
  v.check();
  return out;
}

/**
 * The variants to create: the listed ones, or every combination of `options` when none are listed.
 * Listed variants must only use option names (when options are given) and each combination must be unique.
 */
function resolveVariants(options: OptionIn[] | null, variants: VariantIn[] | null, existing: Attributes[] = []): VariantIn[] {
  let list: VariantIn[];
  if (variants && variants.length) {
    if (options && options.length) {
      const names = options.map((o) => o.name);
      for (const vr of variants) {
        const bad = Object.keys(vr.attributes).find((k) => !names.includes(k));
        if (bad) throw badRequest(`الخاصية "${bad}" مش موجودة في الاختيارات (${names.join("، ")})`, "VALIDATION_ERROR");
      }
    }
    list = variants;
  } else if (options && options.length) {
    const have = new Set(existing.map(attributesKey));
    list = combinations(options)
      .filter((a) => !have.has(attributesKey(a))) // when adding to a group, only the combinations it lacks
      .map((attributes) => ({ attributes, barcode: "", quantity: 0, costPrice: null, wholesalePrice: null, sellingPrice: null, minThreshold: null, description: null }));
  } else {
    throw badRequest("لازم تبعت variants أو options (مثلاً المقاسات والألوان)", "VALIDATION_ERROR");
  }
  if (!list.length) throw badRequest("كل الاختيارات دي موجودة بالفعل في الموديل", "VALIDATION_ERROR");
  return list;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const groupRows = (db: SqlDriver, table: ProductTable, groupId: string) =>
  db.all<any>(`SELECT * FROM "${table}" WHERE "groupId"=? ORDER BY rowid ASC`, [groupId]);

/** One model with its variants and totals. Products without a group are returned as a group of one. */
function groupView(rows: Array<Record<string, any>>): Record<string, any> {
  const first = rows[0]!;
  const isGroup = !!first.groupId;
  const prices = rows.map((r) => Number(r.sellingPrice || 0));
  return {
    groupId: isGroup ? first.groupId : null,
    isVariantGroup: isGroup,
    productId: isGroup ? null : first.id,
    name: isGroup ? (first.groupName || first.name) : first.name,
    category: first.category,
    brand: first.brand,
    description: first.description,
    options: isGroup ? optionsOf(rows) : [],
    variantsCount: rows.length,
    totalQuantity: qtyRound(rows.reduce((t, r) => t + Number(r.quantity || 0), 0)),
    lowStockCount: rows.filter((r) => Number(r.quantity || 0) <= Number(r.minThreshold || 0)).length,
    minPrice: money(Math.min(...prices)),
    maxPrice: money(Math.max(...prices)),
    variants: serializeList(rows),
  };
}

export function getGroup(db: SqlDriver, table: ProductTable, groupId: string): Record<string, any> {
  const rows = groupRows(db, table, groupId);
  if (!rows.length) throw groupNotFound();
  return groupView(rows);
}

export function listGroups(
  db: SqlDriver, table: ProductTable,
  o: { search?: string; category?: string; includeSingles?: boolean; limit: number },
): Array<Record<string, any>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (!o.includeSingles) where.push(`"groupId" IS NOT NULL AND "groupId" != ''`);
  if (o.search && o.search.trim()) {
    const s = `%${o.search.trim()}%`;
    where.push(`(LOWER(name) LIKE LOWER(?) OR LOWER(barcode) LIKE LOWER(?) OR LOWER(COALESCE("groupName", '')) LIKE LOWER(?))`);
    args.push(s, s, s);
  }
  if (o.category && o.category !== "all") { where.push(`category = ?`); args.push(o.category); }
  const matched = db.all<any>(
    `SELECT * FROM "${table}"${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(NULLIF("groupName", ''), name) ASC, rowid ASC`,
    args,
  );
  // A match on one variant brings its whole group; a single product is a group of its own.
  const order: string[] = [];
  const singles = new Map<string, Record<string, any>>();
  const groupIds = new Set<string>();
  for (const r of matched) {
    const key = r.groupId ? `g:${r.groupId}` : `p:${r.id}`;
    if (order.includes(key)) continue;
    order.push(key);
    if (r.groupId) groupIds.add(r.groupId); else singles.set(key, r);
    if (order.length >= o.limit) break;
  }
  const byGroup = new Map<string, Array<Record<string, any>>>();
  const ids = [...groupIds];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db.all<any>(`SELECT * FROM "${table}" WHERE "groupId" IN (${part.map(() => "?").join(",")}) ORDER BY rowid ASC`, part)) {
      (byGroup.get(r.groupId) ?? (byGroup.set(r.groupId, []), byGroup.get(r.groupId)!)).push(r);
    }
  }
  return order.map((k) => (k.startsWith("g:") ? groupView(byGroup.get(k.slice(2))!) : groupView([singles.get(k)!])));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
interface Shared {
  groupId: string; groupName: string; category: string; brand: string; description: string;
  costPrice: number | null; wholesalePrice: number | null; sellingPrice: number | null; minThreshold: number;
}

/** Inserts the variants of a group after checking barcodes and combinations. Returns nothing; read the group after. */
function insertVariants(
  db: SqlDriver, table: ProductTable, shared: Shared, variants: VariantIn[], optionOrder: string[],
  existing: Array<Record<string, any>>, now: string,
): void {
  const seenCombos = new Set(existing.map((r) => attributesKey(normalizeAttributes(r.attributes) ?? {})));
  const seenBarcodes = new Set<string>();
  for (const vr of variants) {
    const label = variantLabelOf(vr.attributes, optionOrder);
    const key = attributesKey(vr.attributes);
    if (seenCombos.has(key)) throw duplicateVariant(label);
    seenCombos.add(key);
    if (vr.barcode) {
      if (seenBarcodes.has(vr.barcode)) throw duplicateBarcode(vr.barcode);
      seenBarcodes.add(vr.barcode);
      const owner = barcodeOwner(db, table, vr.barcode);
      if (owner) throw duplicateBarcode(vr.barcode, owner.name);
    }
  }
  for (const vr of variants) {
    const label = variantLabelOf(vr.attributes, optionOrder);
    const cost = vr.costPrice ?? vr.wholesalePrice ?? shared.costPrice ?? shared.wholesalePrice ?? 0;
    const wholesale = vr.wholesalePrice ?? (vr.costPrice !== null ? cost : (shared.wholesalePrice ?? cost));
    const id = newId();
    insertRow(db, table, {
      id,
      barcode: vr.barcode,
      name: variantName(shared.groupName, label),
      category: shared.category,
      brand: shared.brand,
      quantity: qtyRound(vr.quantity || 0),
      costPrice: money(cost),
      wholesalePrice: money(wholesale || cost),
      sellingPrice: money(vr.sellingPrice ?? shared.sellingPrice ?? 0),
      minThreshold: vr.minThreshold ?? shared.minThreshold,
      description: vr.description ?? shared.description,
      createdAt: now,
      updatedAt: now,
      groupId: shared.groupId,
      groupName: shared.groupName,
      variantLabel: label,
      attributes: vr.attributes,
    });
    const created = getById<any>(db, table, id)!;
    logMovement(db, table, created, 0, created.quantity, { type: "opening" }, now);
  }
}

/** Creates a model and all its variants in one transaction (the router wraps writes in one). */
export function createGroup(db: SqlDriver, table: ProductTable, g: GroupIn, defaultThreshold: number, now: string): Record<string, any> {
  const variants = resolveVariants(g.options, g.variants);
  const optionOrder = g.options?.map((o) => o.name) ?? Object.keys(variants[0]!.attributes);
  const groupId = newId();
  insertVariants(db, table, {
    groupId,
    groupName: g.name,
    category: g.category || settings.DEFAULT_CATEGORY,
    brand: g.brand ?? settings.DEFAULT_BRAND,
    description: g.description || "",
    costPrice: g.costPrice, wholesalePrice: g.wholesalePrice, sellingPrice: g.sellingPrice,
    minThreshold: g.minThreshold ?? defaultThreshold,
  }, variants, optionOrder, [], now);
  return getGroup(db, table, groupId);
}

/** Adds variants (listed, or the missing combinations of `options`) to an existing model. */
export function addVariants(db: SqlDriver, table: ProductTable, groupId: string, body: unknown, now: string): Record<string, any> {
  const rows = groupRows(db, table, groupId);
  if (!rows.length) throw groupNotFound();
  const raw = bodyObject(body);
  const v = new Validation();
  const options = parseOptions(v, raw.options);
  const listed = parseVariants(v, raw.variants);
  const prices = {
    costPrice: floatField(v, raw, "costPrice", { ge: 0 }) ?? null,
    wholesalePrice: floatField(v, raw, "wholesalePrice", { ge: 0 }) ?? null,
    sellingPrice: floatField(v, raw, "sellingPrice", { ge: 0 }) ?? null,
  };
  v.check();
  const existingAttrs = rows.map((r) => normalizeAttributes(r.attributes) ?? {});
  const variants = resolveVariants(options, listed, existingAttrs);
  const first = rows[0]!;
  const order = [...optionsOf(rows).map((o) => o.name), ...(options ?? []).map((o) => o.name)];
  insertVariants(db, table, {
    groupId,
    groupName: first.groupName || first.name,
    category: first.category,
    brand: first.brand,
    description: first.description || "",
    costPrice: prices.costPrice ?? first.costPrice,
    wholesalePrice: prices.wholesalePrice ?? first.wholesalePrice,
    sellingPrice: prices.sellingPrice ?? first.sellingPrice,
    minThreshold: first.minThreshold,
  }, variants, [...new Set(order)], rows, now);
  return getGroup(db, table, groupId);
}

/**
 * Updates what the variants share: name (each variant's full name is rebuilt), category, brand, description,
 * minThreshold. Prices change on EVERY variant only with `applyToAll: true` (variants may have their own prices).
 * Quantities are never touched here: they belong to each variant (stock-take / product edit).
 */
export function updateGroup(db: SqlDriver, table: ProductTable, groupId: string, body: unknown, now: string): Record<string, any> {
  const rows = groupRows(db, table, groupId);
  if (!rows.length) throw groupNotFound();
  const raw = bodyObject(body);
  const v = new Validation();
  const name = raw.name === undefined ? undefined : clean(strField(v, raw, "name", { min: 1, max: 255 }));
  const category = raw.category === undefined ? undefined : strField(v, raw, "category");
  const brand = raw.brand === undefined ? undefined : strField(v, raw, "brand");
  const description = raw.description === undefined ? undefined : strField(v, raw, "description");
  const minThreshold = intField(v, raw, "minThreshold", { ge: 0 });
  const costPrice = floatField(v, raw, "costPrice", { ge: 0 });
  const wholesalePrice = floatField(v, raw, "wholesalePrice", { ge: 0 });
  const sellingPrice = floatField(v, raw, "sellingPrice", { ge: 0 }) ?? floatField(v, raw, "price", { ge: 0 });
  const applyToAll = boolField(v, raw, "applyToAll", false);
  v.check();
  if (name === "") throw badRequest("اسم الموديل مطلوب", "VALIDATION_ERROR");
  const pricesSent = [costPrice, wholesalePrice, sellingPrice].some((x) => x !== null && x !== undefined);
  if (pricesSent && !applyToAll) {
    throw badRequest("تعديل السعر من الموديل بيغيّر سعر كل المقاسات/الألوان: ابعت applyToAll: true، أو عدّل كل variant لوحده", "APPLY_TO_ALL_REQUIRED");
  }

  for (const r of rows) {
    const patch: Record<string, unknown> = {};
    if (name !== undefined) {
      patch.groupName = name;
      patch.name = variantName(name, r.variantLabel || "");
    }
    if (category !== undefined && category !== null) patch.category = category;
    if (brand !== undefined && brand !== null) patch.brand = brand;
    if (description !== undefined && description !== null) patch.description = description;
    if (minThreshold !== null && minThreshold !== undefined) patch.minThreshold = minThreshold;
    if (applyToAll) {
      if (costPrice !== null && costPrice !== undefined) {
        patch.costPrice = money(costPrice);
        if (wholesalePrice === null || wholesalePrice === undefined) patch.wholesalePrice = money(costPrice);
      }
      if (wholesalePrice !== null && wholesalePrice !== undefined) patch.wholesalePrice = money(wholesalePrice);
      if (sellingPrice !== null && sellingPrice !== undefined) patch.sellingPrice = money(sellingPrice);
    }
    if (!Object.keys(patch).length) continue;
    patch.updatedAt = now;
    updateRow(db, table, r.id, patch);
  }
  return getGroup(db, table, groupId);
}

/** Deletes every variant of a model (each removal is logged as a stock movement and synced). */
export function deleteGroup(db: SqlDriver, table: ProductTable, groupId: string, now: string): number {
  const rows = groupRows(db, table, groupId);
  if (!rows.length) throw groupNotFound();
  for (const r of rows) {
    deleteRow(db, table, r.id);
    logMovement(db, table, r, r.quantity || 0, 0, { type: "deleted" }, now);
  }
  return rows.length;
}

/**
 * Edit of one variant's own attributes from the product endpoint (PUT /shop/products/{id}): `attributes` and/or
 * `variantLabel`. Rebuilds the label and the full name and refuses a combination another variant of the group has.
 * Returns the patch to merge (empty when the body changes neither).
 */
export function variantPatch(db: SqlDriver, table: ProductTable, prod: Record<string, any>, data: Record<string, any>): Record<string, any> {
  if (!prod.groupId || (data.attributes === undefined && data.variantLabel === undefined)) return {};
  const patch: Record<string, any> = {};
  let attributes = normalizeAttributes(prod.attributes) ?? {};
  if (data.attributes !== undefined && data.attributes !== null) {
    const next = normalizeAttributes(data.attributes);
    if (!next || !Object.keys(next).length) throw badRequest("الخصائص لازم تكون object فيه خاصية واحدة على الأقل", "VALIDATION_ERROR");
    const key = attributesKey(next);
    const clash = groupRows(db, table, prod.groupId).find((r) => r.id !== prod.id && attributesKey(normalizeAttributes(r.attributes) ?? {}) === key);
    if (clash) throw duplicateVariant(variantLabelOf(next));
    attributes = next;
    patch.attributes = attributes;
  }
  const siblings = groupRows(db, table, prod.groupId);
  const label = data.variantLabel !== undefined && data.variantLabel !== null && clean(data.variantLabel)
    ? clean(data.variantLabel)
    : variantLabelOf(attributes, optionsOf(siblings).map((o) => o.name));
  patch.variantLabel = label;
  patch.name = variantName(prod.groupName || prod.name, label);
  return patch;
}

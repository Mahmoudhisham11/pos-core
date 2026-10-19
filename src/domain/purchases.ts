/** Shop purchases, purchase returns and warehouse<->shop transfers. */
import type { SqlDriver } from "../db/types";
import { getById, insertRow } from "../db/sql";
import { badRequest } from "../http/errors";
import { appendTx, makeTx } from "./ledger";
import {
  EPS, docNumber, dumps, findShopProduct, findWarehouseProduct, fmtG, applyAliases, itemKeyMatches, jsonField, loadsDict, loadsList,
  money, newId, pyStr, qtyRound, saveRow, truthy,
} from "./common";
import { Validation, bodyObject, boolField, dumpModel, floatField, isObj, strField } from "./catalog";
import { logMovement } from "./stock";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
export interface PurchaseItemIn {
  productId?: string | null; barcode: string | null; name?: string | null; productName?: string | null;
  category?: string | null; brand?: string | null; quantity: number;
  costPrice: number | null; wholesalePrice: number | null; unitCost: number | null;
  sellingPrice: number | null; price: number | null;
  /** model_dump(exclude_none=True) */
  dump: Record<string, any>;
  cost: number; sell: number;
}

const PURCHASE_ITEM_FIELDS = ["productId", "barcode", "name", "productName", "category", "brand", "quantity", "costPrice", "wholesalePrice", "unitCost", "sellingPrice", "price"];

function parsePurchaseItem(v: Validation, raw: unknown, idx: number): PurchaseItemIn | null {
  if (!isObj(raw)) { v.add(["items", idx], "Input should be a valid dictionary or object to extract fields from"); return null; }
  const path = ["items", idx];
  const f = (name: string, o: { ge?: number; gt?: number; required?: boolean } = {}) => floatField(v, raw, name, { ...o, path });
  const s = (name: string, def: string | null = null) => strField(v, raw, name, { def, path });
  const p: Record<string, any> = {
    productId: s("productId"), barcode: s("barcode", ""), name: s("name"), productName: s("productName"),
    category: s("category"), brand: s("brand"), quantity: f("quantity", { gt: 0, required: true }),
    costPrice: f("costPrice", { ge: 0 }), wholesalePrice: f("wholesalePrice", { ge: 0 }), unitCost: f("unitCost", { ge: 0 }),
    sellingPrice: f("sellingPrice", { ge: 0 }), price: f("price", { ge: 0 }),
  };
  const first = (...vals: Array<number | null>) => { for (const x of vals) if (x) return Number(x); return 0.0; };
  return {
    ...(p as any),
    dump: dumpModel(PURCHASE_ITEM_FIELDS, p, raw),
    cost: first(p.costPrice, p.wholesalePrice, p.unitCost),
    sell: first(p.sellingPrice, p.price),
  };
}

export interface PurchaseIn {
  id: string | null; invoiceNumber: string | null; items: PurchaseItemIn[]; supplier: any;
  totalCost: number | null; totalAmount: number | null; paidAmount: number | null;
  paymentMethod: string | null; notes: string | null; createdBy: any; date: string | null;
}

export function parsePurchaseIn(body: unknown): PurchaseIn {
  const raw = bodyObject(body);
  const v = new Validation();
  const items: PurchaseItemIn[] = [];
  if (raw.items === undefined || raw.items === null) v.add(["items"], "Field required");
  else if (!Array.isArray(raw.items)) v.add(["items"], "Input should be a valid list");
  else {
    raw.items.forEach((it, i) => { const p = parsePurchaseItem(v, it, i); if (p) items.push(p); });
    if (!raw.items.length) v.add(["items"], "List should have at least 1 item after validation, not 0");
  }
  const out = {
    id: strField(v, raw, "id"), invoiceNumber: strField(v, raw, "invoiceNumber"), items,
    supplier: raw.supplier ?? null,
    totalCost: floatField(v, raw, "totalCost", { ge: 0 }), totalAmount: floatField(v, raw, "totalAmount", { ge: 0 }),
    paidAmount: floatField(v, raw, "paidAmount", { ge: 0 }),
    paymentMethod: strField(v, raw, "paymentMethod", { def: "نقدي" }), notes: strField(v, raw, "notes", { def: "" }),
    createdBy: raw.createdBy ?? null, date: strField(v, raw, "date"),
  };
  v.check();
  return out as PurchaseIn;
}

export interface PurchaseReturnItemIn {
  productId?: string | null; barcode: string | null; name?: string | null; quantity: number;
  costPrice: number | null; unitCost: number | null; dump: Record<string, any>;
}
const RETURN_ITEM_FIELDS = ["productId", "barcode", "name", "quantity", "costPrice", "unitCost"];

export interface PurchaseReturnIn {
  id: string | null; returnNumber: string | null; invoiceId: string | null; originalInvoiceId: string | null; supplier: any;
  returnedItems: PurchaseReturnItemIn[]; totalRefund: number | null; returnReason: string | null;
  deleteIfZero: boolean | null; user: any; notes: string | null;
}

export function parsePurchaseReturnIn(body: unknown): PurchaseReturnIn {
  let raw = bodyObject(body);
  if ("itemsToReturn" in raw && !("returnedItems" in raw)) raw = { ...raw, returnedItems: raw.itemsToReturn }; // ALIASES
  const v = new Validation();
  const items: PurchaseReturnItemIn[] = [];
  if (raw.returnedItems === undefined || raw.returnedItems === null) v.add(["returnedItems"], "Field required");
  else if (!Array.isArray(raw.returnedItems)) v.add(["returnedItems"], "Input should be a valid list");
  else {
    raw.returnedItems.forEach((it: unknown, i: number) => {
      if (!isObj(it)) { v.add(["returnedItems", i], "Input should be a valid dictionary or object to extract fields from"); return; }
      const path = ["returnedItems", i];
      const p: Record<string, any> = {
        productId: strField(v, it, "productId", { path }), barcode: strField(v, it, "barcode", { def: "", path }),
        name: strField(v, it, "name", { path }), quantity: floatField(v, it, "quantity", { gt: 0, required: true, path }),
        costPrice: floatField(v, it, "costPrice", { path }), unitCost: floatField(v, it, "unitCost", { path }),
      };
      items.push({ ...(p as any), dump: dumpModel(RETURN_ITEM_FIELDS, p, it) });
    });
    if (!raw.returnedItems.length) v.add(["returnedItems"], "List should have at least 1 item after validation, not 0");
  }
  const out = {
    id: strField(v, raw, "id"), returnNumber: strField(v, raw, "returnNumber"), invoiceId: strField(v, raw, "invoiceId"),
    originalInvoiceId: strField(v, raw, "originalInvoiceId"), supplier: raw.supplier ?? null, returnedItems: items,
    totalRefund: floatField(v, raw, "totalRefund", { ge: 0 }), returnReason: strField(v, raw, "returnReason", { def: "" }),
    deleteIfZero: boolField(v, raw, "deleteIfZero", false), user: raw.user ?? null, notes: strField(v, raw, "notes", { def: "" }),
  };
  v.check();
  return out as PurchaseReturnIn;
}

export interface TransferIn {
  productId: string | null; productName: string | null; barcode: string | null; quantity: number; direction: string;
  notes: string | null; created_by_name: string | null; createdBy: string | null;
}

export function parseTransferIn(body: unknown): TransferIn {
  let raw = bodyObject(body);
  raw = applyAliases(raw, { product_id: "productId", product_name: "productName" });
  const v = new Validation();
  const out = {
    productId: strField(v, raw, "productId"), productName: strField(v, raw, "productName"),
    barcode: strField(v, raw, "barcode", { def: "" }), quantity: floatField(v, raw, "quantity", { gt: 0, required: true }),
    direction: strField(v, raw, "direction", { required: true }), notes: strField(v, raw, "notes", { def: "" }),
    created_by_name: strField(v, raw, "created_by_name", { def: "المسؤول" }), createdBy: strField(v, raw, "createdBy"),
  };
  v.check();
  return out as TransferIn;
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------
function supplierFrom(db: SqlDriver, raw: unknown): Record<string, any> | undefined {
  const obj = isObj(raw) ? raw : loadsDict(raw);
  const sid = obj ? obj.id : null;
  return sid ? getById(db, "suppliers", String(sid)) : undefined;
}

const PRODUCT_COLS = ["id", "barcode", "name", "category", "brand", "quantity", "costPrice", "wholesalePrice", "sellingPrice", "minThreshold", "description", "createdAt", "updatedAt"];
const pickCols = (row: Record<string, any>) => Object.fromEntries(PRODUCT_COLS.filter((c) => c in row).map((c) => [c, row[c]]));

/** Returns the saved purchase row. */
export function createPurchase(db: SqlDriver, p: PurchaseIn, now: string): Record<string, any> {
  if (p.id) {
    const existing = getById(db, "shop_purchases", p.id);
    if (existing) return existing;
  }

  const today = (p.date || now).slice(0, 10);
  const supplier = supplierFrom(db, p.supplier);

  const computedTotal = money(p.items.reduce((a, i) => a + i.quantity * i.cost, 0));
  let totalCost = money(p.totalCost !== null ? p.totalCost : (p.totalAmount !== null ? p.totalAmount : computedTotal));
  if (Math.abs(totalCost - computedTotal) > 0.01 && computedTotal > 0) totalCost = computedTotal;
  const paid = money(p.paidAmount || 0.0);
  if (paid > totalCost + EPS) throw badRequest("المبلغ المدفوع أكبر من إجمالي الفاتورة", "INVALID_AMOUNT");
  const remaining = money(totalCost - paid);
  if (remaining > 0 && supplier === undefined) {
    // an unpaid balance needs an account to sit on
    throw badRequest("الشراء الآجل أو الجزئي يتطلب اختيار مورد مسجل", "SUPPLIER_REQUIRED");
  }

  let invoiceNum = (p.invoiceNumber || "").trim() || docNumber("INV-PUR", today);
  while (db.get(`SELECT id FROM shop_purchases WHERE invoiceNumber=?`, [invoiceNum])) invoiceNum = docNumber("INV-PUR", today);

  const storedItems: Record<string, any>[] = [];
  for (const it of p.items) {
    let prod: Record<string, any> | undefined = findShopProduct(db, it.barcode, it.productId, it.name || it.productName);
    const name = (it.name || it.productName || "").trim();
    const isNew = prod === undefined;
    if (prod === undefined) {
      if (!name) throw badRequest("اسم الصنف مطلوب للأصناف الجديدة", "VALIDATION_ERROR");
      prod = {
        id: newId(), barcode: (it.barcode || "").trim(), name, category: it.category || "أخرى", brand: it.brand || "Nelly",
        quantity: 0.0, costPrice: 0.0, wholesalePrice: 0.0, sellingPrice: 0.0, minThreshold: 3, description: "", createdAt: now,
      };
    }

    const storedQty = prod.quantity || 0.0;
    const oldQty = Math.max(0.0, storedQty);
    const oldCost = prod.wholesalePrice || prod.costPrice || 0.0;
    if (it.cost > 0) {
      // weighted-average cost keeps profit figures honest across purchases at different prices
      const avg = oldQty > 0 ? (oldQty * oldCost + it.quantity * it.cost) / (oldQty + it.quantity) : it.cost;
      prod.costPrice = prod.wholesalePrice = money(avg);
    }
    if (it.sell > 0) prod.sellingPrice = money(it.sell);
    prod.quantity = qtyRound(oldQty + it.quantity);
    prod.updatedAt = now;
    if (isNew) insertRow(db, "shop_products", pickCols(prod));
    else saveRow(db, "shop_products", prod);
    logMovement(db, "shop_products", prod, storedQty, prod.quantity, { type: "purchase", refType: "shop_purchase", refNumber: invoiceNum }, now);

    const line = { ...it.dump, productId: prod.id, name: name || prod.name, barcode: prod.barcode || "", costPrice: it.cost };
    storedItems.push(line);
  }

  if (supplier !== undefined) {
    const prev = money(supplier.remainingBalance);
    supplier.totalPurchases = money((supplier.totalPurchases || 0) + totalCost);
    supplier.totalPaid = money((supplier.totalPaid || 0) + paid);
    supplier.remainingBalance = money(prev + remaining);
    supplier.balance = supplier.remainingBalance;
    supplier.updatedAt = now;
    appendTx(
      supplier,
      makeTx(
        "tx_pur", "فاتورة مشتريات", totalCost, prev, supplier.remainingBalance,
        `فاتورة مشتريات رقم ${invoiceNum} (مدفوع: ${pyStr(paid)} ج.م، متبقي: ${pyStr(remaining)} ج.م)`,
        p.paymentMethod || "نقدي", { invoiceNumber: invoiceNum },
      ),
    );
    saveRow(db, "suppliers", supplier);
  }

  const id = p.id || newId();
  insertRow(db, "shop_purchases", {
    id,
    invoiceNumber: invoiceNum,
    supplier: jsonField(p.supplier),
    items: dumps(storedItems),
    itemsCount: storedItems.length,
    totalAmount: totalCost,
    totalCost,
    paidAmount: paid,
    remainingDue: remaining,
    paymentMethod: p.paymentMethod || "نقدي",
    status: "COMPLETED",
    notes: p.notes || "",
    createdBy: jsonField(p.createdBy),
    date: today,
    createdAt: now,
    updatedAt: now,
  });
  return getById(db, "shop_purchases", id)!;
}

export function createPurchaseReturn(db: SqlDriver, p: PurchaseReturnIn, now: string): Record<string, any> {
  if (p.id) {
    const existing = getById(db, "shop_purchase_returns", p.id);
    if (existing) return existing;
  }

  const retNum = (p.returnNumber || "").trim() || docNumber("RET-PUR", now.slice(0, 10));
  const invoiceRef = p.originalInvoiceId || p.invoiceId;
  let purchase: Record<string, any> | undefined;
  if (invoiceRef) {
    purchase = getById(db, "shop_purchases", String(invoiceRef))
      ?? db.get<any>(`SELECT * FROM shop_purchases WHERE lower(invoiceNumber)=? LIMIT 1`, [String(invoiceRef).toLowerCase()]);
  }

  // quantities already returned against this purchase
  const already = new Map<number, number>();
  const purchased = purchase ? loadsList(purchase.items) : [];
  if (purchase) {
    const refs = [purchase.id, purchase.invoiceNumber].filter((x) => x !== null && x !== undefined);
    const prevs = db.all<any>(`SELECT * FROM shop_purchase_returns WHERE originalInvoiceId IN (${refs.map(() => "?").join(",")})`, refs);
    for (const prev of prevs) {
      for (const r of loadsList(prev.returnedItems)) {
        const i = purchased.findIndex((o) => itemKeyMatches(o, r));
        if (i >= 0) already.set(i, (already.get(i) || 0) + Number(r.quantity || 0));
      }
    }
  }

  let refund = 0.0;
  const records: Record<string, any>[] = [];
  for (const it of p.returnedItems) {
    const item = it.dump;
    let unitCost = it.costPrice || it.unitCost || 0.0;
    const label = it.name || it.barcode || "";
    if (purchase) {
      const idx = purchased.findIndex((o) => itemKeyMatches(o, item));
      if (idx < 0) throw badRequest(`الصنف ليس ضمن فاتورة الشراء: ${label}`, "ITEM_NOT_IN_INVOICE");
      if ((already.get(idx) || 0) + it.quantity > Number(purchased[idx]!.quantity || 0) + EPS) {
        throw badRequest(`كمية المرتجع أكبر من المشتراة: ${label}`, "RETURN_EXCEEDS_PURCHASED");
      }
      already.set(idx, (already.get(idx) || 0) + it.quantity);
      unitCost = Number(purchased[idx]!.costPrice || purchased[idx]!.unitCost || unitCost || 0);
    }

    const prod = findShopProduct(db, it.barcode, it.productId, it.name);
    if (prod === undefined) throw badRequest(`الصنف غير موجود في المحل: ${label}`, "PRODUCT_NOT_FOUND");
    if (prod.quantity + EPS < it.quantity) {
      throw badRequest(`الرصيد في المحل لا يكفي لإرجاع ${prod.name} (المتاح ${fmtG(prod.quantity)})`, "INSUFFICIENT_STOCK");
    }
    const before = prod.quantity;
    prod.quantity = qtyRound(prod.quantity - it.quantity);
    prod.updatedAt = now;
    saveRow(db, "shop_products", prod);
    logMovement(db, "shop_products", prod, before, prod.quantity, {
      type: "purchase_return", refType: "shop_purchase_return", refNumber: retNum,
      reason: purchase ? `من فاتورة الشراء #${purchase.invoiceNumber}` : "",
    }, now);

    refund += it.quantity * unitCost;
    records.push({ ...item, productId: prod.id, costPrice: money(unitCost) });
  }

  refund = refund > 0 ? money(refund) : money(p.totalRefund || 0);

  const supplier = supplierFrom(db, p.supplier) ?? (purchase ? supplierFrom(db, purchase.supplier) : undefined);
  if (supplier !== undefined && refund > 0) {
    const prev = money(supplier.remainingBalance);
    const debtCut = money(Math.min(refund, Math.max(0.0, prev)));
    supplier.totalPurchases = money(Math.max(0.0, (supplier.totalPurchases || 0) - refund));
    supplier.remainingBalance = money(prev - debtCut);
    supplier.balance = supplier.remainingBalance;
    supplier.updatedAt = now;
    appendTx(
      supplier,
      makeTx(
        "tx_pret", "مرتجع مشتريات", refund, prev, supplier.remainingBalance,
        `مرتجع مشتريات #${retNum}` + (debtCut > 0 ? ` (تم تخفيض ${pyStr(debtCut)} ج.م من المستحقات)` : ""),
        "مرتجع", { returnNumber: retNum },
      ),
    );
    saveRow(db, "suppliers", supplier);
  }

  const id = p.id || newId();
  insertRow(db, "shop_purchase_returns", {
    id,
    returnNumber: retNum,
    invoiceId: p.invoiceId || "",
    originalInvoiceId: invoiceRef || "",
    supplier: truthy(p.supplier) ? jsonField(p.supplier) : (purchase ? purchase.supplier : ""),
    itemsToReturn: dumps(records),
    returnedItems: dumps(records),
    totalRefund: refund,
    returnReason: p.returnReason || "",
    deleteIfZero: p.deleteIfZero ? 1 : 0,
    user: jsonField(p.user),
    notes: p.notes || "",
    createdAt: now,
    updatedAt: now,
  });
  return getById(db, "shop_purchase_returns", id)!;
}

// ---------------------------------------------------------------------------
// Transfers (warehouse <-> shop)
// ---------------------------------------------------------------------------
function cloneProduct(src: Record<string, any>, qty: number, now: string): Record<string, any> {
  return {
    id: newId(), barcode: src.barcode, name: src.name, category: src.category, brand: src.brand,
    quantity: qty, costPrice: src.costPrice, wholesalePrice: src.wholesalePrice,
    sellingPrice: src.sellingPrice, minThreshold: src.minThreshold, description: src.description,
    createdAt: now, updatedAt: now,
  };
}

export function createTransfer(db: SqlDriver, p: TransferIn, now: string): Record<string, any> {
  if (p.direction !== "to_shop" && p.direction !== "to_warehouse") throw badRequest("اتجاه التحويل غير صالح", "VALIDATION_ERROR");

  const qty = qtyRound(p.quantity);
  const name = p.productName;
  let shopP: Record<string, any> | undefined = findShopProduct(db, p.barcode, p.productId, name);
  let whP: Record<string, any> | undefined = findWarehouseProduct(db, p.barcode, p.productId, name);
  // The id sent belongs to one side only: find the other side by the found product's own barcode / name too, so a
  // transfer never creates a second copy of a product that already exists there under that barcode or name.
  if (shopP === undefined && whP !== undefined) shopP = findShopProduct(db, whP.barcode, null, whP.name);
  if (whP === undefined && shopP !== undefined) whP = findWarehouseProduct(db, shopP.barcode, null, shopP.name);
  let shopNew = false, whNew = false;
  const whBefore = whP ? whP.quantity || 0 : 0;
  const shopBefore = shopP ? shopP.quantity || 0 : 0;

  if (p.direction === "to_shop") {
    if (whP === undefined) throw badRequest("الصنف غير موجود في المخزن", "PRODUCT_NOT_FOUND");
    if (whP.quantity + EPS < qty) throw badRequest(`الرصيد في المخزن لا يكفي (${fmtG(whP.quantity)} متاح)`, "INSUFFICIENT_STOCK");
    whP.quantity = qtyRound(whP.quantity - qty);
    whP.updatedAt = now;
    if (shopP === undefined) { shopP = cloneProduct(whP, 0.0, now); shopNew = true; }
    shopP!.quantity = qtyRound((shopP!.quantity || 0) + qty);
    shopP!.updatedAt = now;
  } else {
    if (shopP === undefined) throw badRequest("الصنف غير موجود في المحل", "PRODUCT_NOT_FOUND");
    if (shopP.quantity + EPS < qty) throw badRequest(`الرصيد في المحل لا يكفي (${fmtG(shopP.quantity)} متاح)`, "INSUFFICIENT_STOCK");
    shopP.quantity = qtyRound(shopP.quantity - qty);
    shopP.updatedAt = now;
    if (whP === undefined) { whP = cloneProduct(shopP, 0.0, now); whNew = true; }
    whP!.quantity = qtyRound((whP!.quantity || 0) + qty);
    whP!.updatedAt = now;
  }
  // persist after all checks passed (the surrounding transaction also rolls back on throw)
  if (whP) { if (whNew) insertRow(db, "products", pickCols(whP)); else saveRow(db, "products", whP); }
  if (shopP) { if (shopNew) insertRow(db, "shop_products", pickCols(shopP)); else saveRow(db, "shop_products", shopP); }

  const src = p.direction === "to_shop" ? whP! : shopP!;
  const id = newId();
  const toShop = p.direction === "to_shop";
  const ref = { refType: "transfer", refNumber: id };
  logMovement(db, "products", whP!, whBefore, whP!.quantity, { type: toShop ? "transfer_out" : "transfer_in", ...ref, reason: toShop ? "إلى المحل" : "من المحل" }, now);
  logMovement(db, "shop_products", shopP!, shopBefore, shopP!.quantity, { type: toShop ? "transfer_in" : "transfer_out", ...ref, reason: toShop ? "من المخزن" : "إلى المخزن" }, now);
  insertRow(db, "transfers", {
    id,
    productId: p.productId || src.id,
    productName: name || src.name,
    barcode: p.barcode || src.barcode || "",
    quantity: qty,
    direction: p.direction,
    notes: p.notes || "",
    createdBy: p.createdBy || p.created_by_name || "المسؤول",
    createdAt: now,
    updatedAt: now,
  });
  return getById(db, "transfers", id)!;
}

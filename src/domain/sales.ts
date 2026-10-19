/** Sales and sales-return business rules. Callers own the transaction (the router wraps writes in one). */
import type { SqlDriver } from "../db/types";
import { deleteRow, getById, insertRow, updateRow } from "../db/sql";
import { utcnowIso, cairoDateStr } from "../core/timeutil";
import { HttpError } from "../http/errors";
import * as ledger from "./ledger";
import { refreshReport } from "./shifts";
import { logMovement, type MovementMeta } from "./stock";
import {
  EPS, Validator, applyAliases, badRequest, docNumber, dumps, findShopProduct, fmtG, itemKeyMatches, jsonField,
  loadsDict, loadsList, money, newId, pyStr, qtyRound, saveRow, truthy, validationError,
} from "./common";

export const CREDIT_METHOD = "آجل";
export const FULL_RETURN_STATUS = "مرتجعة";

// ---------------------------------------------------------------------------
// Request models
// ---------------------------------------------------------------------------
export interface SaleItemIn {
  productId?: string; id?: string; barcode?: string; name?: string; quantity: number;
  sellingPrice?: number; price?: number; wholesalePrice?: number; costPrice?: number;
  /** model_dump(exclude_none=True): declared + extra keys, nulls dropped */
  dump: Record<string, any>;
}
export interface SaleIn {
  id?: string; invoiceNumber?: string; items: SaleItemIn[]; customer?: any; customerName?: string; sellerEmployee?: any;
  cashier?: any; paymentMethod?: string; discount: number; paidAmount?: number; notes?: string; status?: string;
  date?: string; createdAt?: string;
}
export interface ReturnItemIn {
  productId?: string; id?: string; barcode?: string; name?: string; quantity?: number; returnedQty?: number;
  sellingPrice?: number; price?: number; wholesalePrice?: number; costPrice?: number;
  dump: Record<string, any>;
  qty: number;
}
export interface ReturnIn {
  id?: string; returnNumber?: string; invoiceId?: string; invoiceNumber?: string; returnedItems?: ReturnItemIn[];
  refundedAmount?: number; returnReason?: string; customer?: any; cashier?: any; date?: string; createdAt?: string;
  /** closed-day report that still holds the invoice inside it (invoices of old closed days are not separate sales rows) */
  reportId?: string;
}

const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const present = (v: unknown) => v !== undefined && v !== null;

function body422(): HttpError {
  return validationError([{ field: "body", message: "Input should be a valid dictionary or object to extract fields from" }]);
}

/** Optional[str] field: null/absent -> undefined, wrong type -> validation error. */
function optStr(v: Validator, loc: Array<string | number>, x: unknown): string | undefined {
  return present(x) ? v.str(loc, x) : undefined;
}
function optNum(v: Validator, loc: Array<string | number>, x: unknown, opts: { gt?: number; ge?: number } = {}): number | undefined {
  return present(x) ? v.num(loc, x, opts) : undefined;
}

const SALE_ITEM_FIELDS = ["productId", "id", "barcode", "name", "quantity", "sellingPrice", "price", "wholesalePrice", "costPrice"];
const RETURN_ITEM_FIELDS = ["productId", "id", "barcode", "name", "quantity", "returnedQty", "sellingPrice", "price", "wholesalePrice", "costPrice"];
const STR_FIELDS = new Set(["productId", "id", "barcode", "name"]);

/** Shared by both item models: coerce declared fields, keep the rest as extras, drop nulls. */
function parseItemFields(v: Validator, loc: Array<string | number>, raw: Record<string, any>, fields: string[], quantityRule?: { gt: number }) {
  const dump: Record<string, any> = {};
  const declared = new Set(fields);
  for (const [k, val] of Object.entries(raw)) if (!declared.has(k) && present(val)) dump[k] = val;
  const out: Record<string, any> = {};
  for (const f of fields) {
    const x = raw[f];
    let val: any;
    if (f === "quantity" && quantityRule) {
      val = x === undefined ? (v.add([...loc, f], "Field required"), undefined) : v.num([...loc, f], x, quantityRule);
    } else if (STR_FIELDS.has(f)) {
      val = optStr(v, [...loc, f], x);
      if (f === "barcode" && x === undefined) val = ""; // declared default
    } else {
      val = optNum(v, [...loc, f], x, f === "quantity" || f === "returnedQty" ? {} : (quantityRule ? { ge: 0 } : {}));
    }
    out[f] = val;
    if (present(val)) dump[f] = val;
  }
  return { out, dump };
}

export function parseSaleIn(body: unknown): SaleIn {
  if (!isObj(body)) throw body422();
  const d = applyAliases(body, {
    invoice_number: "invoiceNumber", paid_amount: "paidAmount", payment_method: "paymentMethod",
    customer_name: "customerName", discount_amount: "discount", seller_employee: "sellerEmployee",
  });
  const v = new Validator();
  const p: any = {};
  p.id = optStr(v, ["id"], d.id);
  p.invoiceNumber = optStr(v, ["invoiceNumber"], d.invoiceNumber);
  p.items = [];
  if (d.items === undefined) v.add(["items"], "Field required");
  else if (!Array.isArray(d.items)) v.add(["items"], "Input should be a valid list");
  else if (d.items.length === 0) v.add(["items"], "List should have at least 1 item after validation, not 0");
  else {
    d.items.forEach((raw: unknown, i: number) => {
      if (!isObj(raw)) { v.add(["items", i], "Input should be a valid dictionary or object to extract fields from"); return; }
      const item = applyAliases(raw, { product_id: "productId", cost_price: "costPrice", wholesale_price: "wholesalePrice", selling_price: "sellingPrice" });
      const { out, dump } = parseItemFields(v, ["items", i], item, SALE_ITEM_FIELDS, { gt: 0 });
      p.items.push({ ...out, dump });
    });
  }
  p.customer = d.customer ?? null;
  p.customerName = optStr(v, ["customerName"], d.customerName);
  p.sellerEmployee = d.sellerEmployee ?? null;
  p.cashier = d.cashier ?? null;
  p.paymentMethod = optStr(v, ["paymentMethod"], d.paymentMethod);
  p.discount = present(d.discount) ? v.num(["discount"], d.discount, { ge: 0 }) ?? 0 : 0;
  p.paidAmount = optNum(v, ["paidAmount"], d.paidAmount, { ge: 0 });
  p.notes = d.notes === undefined ? "" : optStr(v, ["notes"], d.notes);
  p.status = optStr(v, ["status"], d.status);
  p.date = optStr(v, ["date"], d.date);
  p.createdAt = optStr(v, ["createdAt"], d.createdAt);
  v.throwIfAny();
  return p as SaleIn;
}

export function parseReturnIn(body: unknown): ReturnIn {
  if (!isObj(body)) throw body422();
  const d = applyAliases(body, {
    invoice_id: "invoiceId", original_sale_id: "invoiceId", invoice_number: "invoiceNumber", reason: "returnReason",
    items: "returnedItems", itemsToReturn: "returnedItems",
  });
  const v = new Validator();
  const p: any = {};
  p.id = optStr(v, ["id"], d.id);
  p.returnNumber = optStr(v, ["returnNumber"], d.returnNumber);
  p.invoiceId = optStr(v, ["invoiceId"], d.invoiceId);
  p.invoiceNumber = optStr(v, ["invoiceNumber"], d.invoiceNumber);
  p.reportId = optStr(v, ["reportId"], d.reportId);
  if (present(d.returnedItems)) {
    if (!Array.isArray(d.returnedItems)) v.add(["returnedItems"], "Input should be a valid list");
    else {
      p.returnedItems = [];
      d.returnedItems.forEach((raw: unknown, i: number) => {
        if (!isObj(raw)) { v.add(["returnedItems", i], "Input should be a valid dictionary or object to extract fields from"); return; }
        const item = applyAliases(raw, { product_id: "productId" });
        const { out, dump } = parseItemFields(v, ["returnedItems", i], item, RETURN_ITEM_FIELDS);
        const qty = Number(present(out.quantity) ? out.quantity : (present(out.returnedQty) ? out.returnedQty : 1));
        p.returnedItems.push({ ...out, dump, qty });
      });
    }
  }
  p.refundedAmount = optNum(v, ["refundedAmount"], d.refundedAmount, { ge: 0 });
  p.returnReason = optStr(v, ["returnReason"], d.returnReason);
  p.customer = d.customer ?? null;
  p.cashier = d.cashier ?? null;
  p.date = optStr(v, ["date"], d.date);
  p.createdAt = optStr(v, ["createdAt"], d.createdAt);
  v.throwIfAny();
  return p as ReturnIn;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uniqueInvoiceNumber(db: SqlDriver, requested: string | undefined, today: string): string {
  let candidate = (requested || "").trim() || docNumber("INV", today);
  const base = candidate;
  let n = 1;
  while (db.get(`SELECT id FROM sales WHERE invoiceNumber=? LIMIT 1`, [candidate]) !== undefined) {
    n += 1;
    candidate = requested ? `${base}-${n}` : docNumber("INV", today);
  }
  return candidate;
}

function customerId(raw: unknown): string | null {
  const obj = isObj(raw) ? raw : loadsDict(raw);
  const cid = obj ? obj.id : null;
  return cid ? String(cid) : null;
}

const commissionRate = (emp: any): number => Number(emp.commissionRate !== null && emp.commissionRate !== undefined ? emp.commissionRate : 0.01);

const itemLabel = (it: Record<string, any>): string => it.name || "صنف";

// ---------------------------------------------------------------------------
// Create sale
// ---------------------------------------------------------------------------
export function createSale(db: SqlDriver, p: SaleIn, nowDate: Date = new Date()): Record<string, any> {
  if (p.id) {
    const existing = getById(db, "sales", p.id);
    if (existing) return existing; // same invoice id sent twice: never deduct stock again
  }

  const now = utcnowIso(nowDate);
  const today = cairoDateStr(p.date || now) ?? now.slice(0, 10);

  // 1. Resolve products and validate stock (aggregated per product). One in-memory row per product id.
  const products = new Map<string, any>();
  const needed = new Map<string, number>();
  const resolved: Array<[SaleItemIn, any]> = [];
  for (const it of p.items) {
    const found = findShopProduct(db, it.barcode, it.productId || it.id, it.name);
    if (found === undefined) {
      throw badRequest(`الصنف غير موجود في المحل: ${it.name || it.barcode || it.productId}`, "PRODUCT_NOT_FOUND");
    }
    const prod = products.get(found.id) ?? (products.set(found.id, found), found);
    needed.set(prod.id, (needed.get(prod.id) ?? 0) + it.quantity);
    resolved.push([it, prod]);
  }

  const shortages: string[] = [];
  const seen = new Set<string>();
  for (const [, prod] of resolved) {
    if (seen.has(prod.id)) continue;
    seen.add(prod.id);
    if (prod.quantity + EPS < needed.get(prod.id)!) {
      shortages.push(`${prod.name} (المتاح ${fmtG(prod.quantity)}، المطلوب ${fmtG(needed.get(prod.id)!)})`);
    }
  }
  if (shortages.length) throw badRequest("الكمية غير كافية في المحل: " + shortages.join(" | "), "INSUFFICIENT_STOCK");

  // 2. Money is recomputed server-side from the lines
  const lineItems: Record<string, any>[] = [];
  const moves: Array<[any, number, number]> = [];
  let subtotal = 0, totalCost = 0;
  for (const [it, prod] of resolved) {
    const unitPrice = it.sellingPrice !== undefined ? it.sellingPrice : (it.price !== undefined ? it.price : prod.sellingPrice);
    const unitCost = prod.wholesalePrice || prod.costPrice || it.wholesalePrice || it.costPrice || 0.0;
    const lineSub = money(it.quantity * unitPrice);
    const lineCost = money(it.quantity * unitCost);
    subtotal += lineSub;
    totalCost += lineCost;
    const item: Record<string, any> = { ...it.dump };
    Object.assign(item, {
      productId: prod.id,
      barcode: prod.barcode || it.barcode || "",
      name: it.name || prod.name,
      category: item.category || prod.category,
      quantity: it.quantity,
      sellingPrice: money(unitPrice),
      wholesalePrice: money(unitCost),
      costPrice: money(unitCost),
      subtotal: lineSub,
      profit: money(lineSub - lineCost),
    });
    delete item.price;
    lineItems.push(item);
    const before = prod.quantity;
    prod.quantity = qtyRound(prod.quantity - it.quantity);
    moves.push([prod, before, prod.quantity]);
    prod.updatedAt = now;
  }

  subtotal = money(subtotal);
  totalCost = money(totalCost);
  const discount = money(p.discount);
  if (discount > subtotal + EPS) throw badRequest("قيمة الخصم أكبر من إجمالي الفاتورة", "INVALID_DISCOUNT");
  const total = money(subtotal - discount);
  // Same rule as the cashier screen, enforced here for every device: a discount may never take the invoice down to
  // its wholesale cost (weighted-average purchase cost) or below it.
  if (discount > 0 && totalCost > 0 && total <= totalCost + EPS) {
    throw badRequest(`ممنوع تطبيق هذا الخصم: لا يمكن أن يصل سعر البيع لسعر جملة البضاعة (${pyStr(totalCost)} ج.م) أو أقل منه.`, "DISCOUNT_BELOW_COST");
  }
  const totalProfit = money(total - totalCost);

  const method = (p.paymentMethod || "نقدي").trim();
  const paid = money(p.paidAmount !== undefined ? p.paidAmount : (method === CREDIT_METHOD ? 0.0 : total));
  const remaining = money(Math.max(0.0, total - paid));
  const changeDue = money(Math.max(0.0, paid - total));

  // 3. Customer account
  const custId = customerId(p.customer);
  const cust: any = custId ? getById(db, "customers", custId) : undefined;
  if (remaining > 0 && !cust) throw badRequest("البيع الآجل أو الجزئي يتطلب اختيار عميل مسجل", "CUSTOMER_REQUIRED");

  const invoiceNum = uniqueInvoiceNumber(db, p.invoiceNumber, today);
  let custName = p.customerName || "عميل نقدي";
  if (cust) {
    const prevBalance = money(cust.remainingBalance);
    custName = cust.name;
    cust.totalPurchases = money((cust.totalPurchases || 0) + total);
    cust.totalPaid = money((cust.totalPaid || 0) + Math.min(paid, total));
    ledger.customerSetBalance(cust, prevBalance + remaining);
    cust.updatedAt = now;
    ledger.appendTx(
      cust,
      ledger.makeTx(
        "ctx_inv",
        remaining > 0 ? "فاتورة مبيعات آجل" : "فاتورة مبيعات نقدي",
        remaining > 0 ? remaining : total,
        prevBalance,
        cust.remainingBalance,
        `فاتورة مبيعات رقم ${invoiceNum}`
          + (remaining > 0 ? ` (المتبقي: ${pyStr(remaining)} ج.م من إجمالي: ${pyStr(total)} ج.م)` : ` (مسددة بالكامل: ${pyStr(total)} ج.م)`),
        remaining > 0 ? CREDIT_METHOD : method,
        { invoiceNumber: invoiceNum },
      ),
    );
  }

  // 4. Seller commission
  const seller = isObj(p.sellerEmployee) ? p.sellerEmployee : loadsDict(p.sellerEmployee);
  if (seller && seller.id) {
    const emp: any = getById(db, "employees", String(seller.id));
    if (emp) {
      const rate = commissionRate(emp);
      const comm = money(total * rate);
      if (comm > 0) {
        const month = today.slice(0, 7);
        insertRow(db, "employee_transactions", {
          id: newId(), employeeId: emp.id, employeeName: emp.name, type: "commission",
          amount: comm, date: today, month, monthStr: month, invoiceNumber: invoiceNum,
          notes: `عمولة مبيعات بنسبة ${(rate * 100).toFixed(1)}% من الفاتورة #${invoiceNum}`, createdAt: now,
        });
      }
    }
  }

  // stock + customer changes are flushed together with the invoice
  for (const prod of products.values()) saveRow(db, "shop_products", prod);
  if (cust) saveRow(db, "customers", cust);
  for (const [prod, before, after] of moves) {
    logMovement(db, "shop_products", prod, before, after, { type: "sale", refType: "sale", refNumber: invoiceNum }, now);
  }

  const sale = {
    id: p.id || newId(),
    invoiceNumber: invoiceNum,
    customer: jsonField(p.customer),
    customerName: custName,
    sellerEmployee: jsonField(seller !== null ? seller : p.sellerEmployee),
    cashier: jsonField(p.cashier),
    paymentMethod: method,
    subtotal,
    discount,
    discountType: "fixed",
    total,
    paidAmount: paid,
    remainingDue: remaining,
    changeDue,
    totalCost,
    totalProfit,
    items: dumps(lineItems),
    itemsCount: Math.trunc(lineItems.reduce((a, i) => a + i.quantity, 0)),
    notes: p.notes || "",
    status: p.status || "COMPLETED",
    date: today,
    createdAt: p.createdAt || now,
    updatedAt: now,
    shiftReportId: null,
  };
  insertRow(db, "sales", sale);
  return getById(db, "sales", sale.id)!;
}

export function voidSale(db: SqlDriver, sale: Record<string, any>, nowDate: Date = new Date()): void {
  /** Delete an open-shift invoice and undo its effects (stock, customer account, commission). */
  if (sale.shiftReportId) {
    throw new HttpError(409, { error_code: "CONFLICT", message: "لا يمكن حذف فاتورة تم تقفيل ورديتها. استخدم المرتجع.", details: {} });
  }
  const now = utcnowIso(nowDate);

  if (sale.status !== FULL_RETURN_STATUS) {
    const meta: MovementMeta = { type: "sale_void", refType: "sale", refNumber: sale.invoiceNumber };
    for (const item of loadsList(sale.items)) restock(db, item, Number(item.quantity || 0), now, meta);

    const custId = customerId(sale.customer);
    const cust: any = custId ? getById(db, "customers", custId) : undefined;
    if (cust) {
      const prev = money(cust.remainingBalance);
      cust.totalPurchases = money(Math.max(0.0, (cust.totalPurchases || 0) - (sale.total || 0)));
      cust.totalPaid = money(Math.max(0.0, (cust.totalPaid || 0) - Math.min(sale.paidAmount || 0, sale.total || 0)));
      ledger.customerSetBalance(cust, prev - (sale.remainingDue || 0));
      cust.updatedAt = now;
      ledger.appendTx(
        cust,
        ledger.makeTx("ctx_void", "إلغاء فاتورة مبيعات", sale.total || 0, prev, cust.remainingBalance,
          `إلغاء الفاتورة رقم ${sale.invoiceNumber}`, "إلغاء", { invoiceNumber: sale.invoiceNumber }),
      );
      saveRow(db, "customers", cust);
    }
  }

  const txs = db.all<any>(`SELECT id FROM employee_transactions WHERE invoiceNumber=? AND type='commission'`, [sale.invoiceNumber]);
  for (const tx of txs) deleteRow(db, "employee_transactions", tx.id); // routed through deleteRow so the removal is queued for sync too
  deleteRow(db, "sales", sale.id);
}

// ---------------------------------------------------------------------------
// Sales return
// ---------------------------------------------------------------------------
function restock(db: SqlDriver, item: Record<string, any>, qty: number, now: string, meta: MovementMeta): void {
  let prod: any = findShopProduct(db, item.barcode, item.productId || item.product_id || item.id, item.name);
  if (prod === undefined) {
    prod = {
      id: newId(),
      barcode: (item.barcode || "").trim(),
      name: item.name || item.productName || "صنف مرتجع",
      category: item.category || "أخرى",
      brand: item.brand || "Nelly",
      quantity: 0.0,
      costPrice: money(item.costPrice || item.wholesalePrice || 0),
      wholesalePrice: money(item.wholesalePrice || item.costPrice || 0),
      sellingPrice: money(item.sellingPrice || item.price || 0),
      minThreshold: 3,
      description: "",
      createdAt: now,
      updatedAt: null,
    };
    insertRow(db, "shop_products", prod);
  }
  const before = prod.quantity || 0;
  prod.quantity = qtyRound(before + qty);
  prod.updatedAt = now;
  saveRow(db, "shop_products", prod);
  logMovement(db, "shop_products", prod, before, prod.quantity, meta, now);
}

function findSale(db: SqlDriver, invoiceId?: string, invoiceNumber?: string): any | undefined {
  if (invoiceId) {
    const sale = getById(db, "sales", String(invoiceId));
    if (sale) return sale;
  }
  const num = (invoiceNumber || "").trim();
  if (num) return db.get(`SELECT * FROM sales WHERE lower(invoiceNumber)=? LIMIT 1`, [num.toLowerCase()]);
  return undefined;
}


// ---------------------------------------------------------------------------
// Invoices that live only inside a closed day's report (imported from the old app)
// ---------------------------------------------------------------------------
interface ArchivedInvoice { report: Record<string, any>; invoices: Record<string, any>[]; index: number; sale: Record<string, any> }

const pick = (o: Record<string, any>, ...keys: string[]): any => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The invoice as a plain sale row (camelCase, items as JSON text) so the normal return rules can run on it. */
function archivedAsSale(inv: Record<string, any>): Record<string, any> {
  const total = money(num(pick(inv, "total", "total_amount")));
  const cost = money(num(pick(inv, "totalCost", "total_cost")));
  const profit = pick(inv, "totalProfit", "total_profit");
  const items = loadsList(inv.items);
  return {
    ...inv,
    id: String(pick(inv, "id", "local_id") ?? ""),
    invoiceNumber: String(pick(inv, "invoiceNumber", "invoice_number") ?? ""),
    items: dumps(items),
    customer: jsonField(inv.customer),
    sellerEmployee: jsonField(pick(inv, "sellerEmployee", "seller_employee")),
    paymentMethod: String(pick(inv, "paymentMethod", "payment_method") || "نقدي"),
    subtotal: money(num(pick(inv, "subtotal", "subtotal_amount") ?? total)),
    discount: money(num(pick(inv, "discount", "discount_amount"))),
    total, totalCost: cost,
    totalProfit: profit !== undefined ? money(num(profit)) : money(total - cost),
    paidAmount: money(num(pick(inv, "paidAmount", "paid_amount") ?? total)),
    remainingDue: money(num(pick(inv, "remainingDue", "remaining_due"))),
    status: inv.status || "",
  };
}

function findArchivedInvoice(db: SqlDriver, reportId: string, invoiceNumber: string | undefined): ArchivedInvoice {
  const report = getById<any>(db, "shift_reports", reportId);
  if (!report) throw badRequest("تقفيلة اليوم غير موجودة", "REPORT_NOT_FOUND");
  const wanted = (invoiceNumber || "").trim().toLowerCase();
  const invoices = loadsList(report.invoices);
  const index = wanted ? invoices.findIndex((i) => String(pick(i, "invoiceNumber", "invoice_number") ?? "").trim().toLowerCase() === wanted) : -1;
  if (index < 0) throw badRequest("الفاتورة غير موجودة داخل تقفيلة هذا اليوم", "INVOICE_NOT_IN_REPORT");
  return { report, invoices, index, sale: archivedAsSale(invoices[index]!) };
}

/** Writes the returned invoice back into its closed day and moves that day's totals by exactly what was returned. */
function saveArchived(
  db: SqlDriver, a: ArchivedInvoice, sale: Record<string, any>,
  before: { total: number; cost: number; profit: number; discount: number; paid: number; qty: number },
  returnNumber: string, today: string, now: string,
): void {
  const afterQty = loadsList(sale.items).reduce((acc, i) => acc + Number(i.quantity || 0), 0);
  const patched = {
    ...a.invoices[a.index]!,
    items: loadsList(sale.items), itemsCount: sale.itemsCount, items_count: sale.itemsCount,
    subtotal: sale.subtotal, discount: sale.discount, total: sale.total,
    totalCost: sale.totalCost, total_cost: sale.totalCost, totalProfit: sale.totalProfit, total_profit: sale.totalProfit,
    paidAmount: sale.paidAmount, paid_amount: sale.paidAmount, remainingDue: sale.remainingDue, remaining_due: sale.remainingDue,
    changeDue: 0, change_due: 0, status: sale.status, updatedAt: now,
  };
  const invoices = a.invoices.map((inv, i) => (i === a.index ? patched : inv));
  const report = a.report;
  const breakdown: Record<string, number> = { ...(loadsDict(report.paymentBreakdown) ?? {}) };
  const refund = money(before.total - sale.total);
  const method = String(sale.paymentMethod || "نقدي");
  breakdown[method] = money(Math.max(0, num(breakdown[method]) - refund));
  const down = (cur: unknown, delta: number) => money(Math.max(0, num(cur) - delta));
  updateRow(db, "shift_reports", String(report.id), {
    invoices: dumps(invoices),
    totalSales: down(report.totalSales, refund),
    totalCost: down(report.totalCost, before.cost - sale.totalCost),
    totalProfit: money(num(report.totalProfit) - (before.profit - sale.totalProfit)),
    totalDiscount: down(report.totalDiscount, before.discount - sale.discount),
    totalPaid: down(report.totalPaid, before.paid - sale.paidAmount),
    totalItemsSold: down(report.totalItemsSold, before.qty - afterQty),
    paymentBreakdown: dumps(breakdown),
    notes: `${report.notes ? report.notes + "\n" : ""}مرتجع #${returnNumber} بتاريخ ${today} من فاتورة #${sale.invoiceNumber} بقيمة ${pyStr(refund)} ج.م`,
  });
}

export function createReturn(db: SqlDriver, p: ReturnIn, nowDate: Date = new Date()): Record<string, any> {
  if (p.id) {
    const existing = getById(db, "sales_returns", p.id);
    if (existing) return existing;
  }

  const now = utcnowIso(nowDate);
  const today = cairoDateStr(p.date || now) ?? now.slice(0, 10);
  const retNum = p.returnNumber || docNumber("RET", today);
  const reason = (p.returnReason || "مرتجع مبيعات").trim();
  let sale: any = findSale(db, p.invoiceId, p.invoiceNumber);
  let archived: ArchivedInvoice | undefined;
  if (sale === undefined && p.reportId) {
    archived = findArchivedInvoice(db, p.reportId, p.invoiceNumber);
    sale = archived.sale;
  }
  let requested: Record<string, any>[] = (p.returnedItems || []).map((r) => ({ ...r.dump, quantity: r.qty }));

  let refund = 0.0;
  let cashRefund = 0.0; // money actually handed back (the rest only reduced a credit invoice's debt)
  let refundMethod = "نقدي";
  const returnedRecords: Record<string, any>[] = [];

  if (sale !== undefined) {
    const origItems = loadsList(sale.items);
    if (sale.status === FULL_RETURN_STATUS || !origItems.length) {
      throw badRequest("هذه الفاتورة تم إرجاعها بالكامل من قبل", "ALREADY_RETURNED");
    }

    // return everything when no lines were specified
    if (!requested.length) requested = origItems.map((o) => ({ ...o }));

    const remainingQty = origItems.map((o) => Number(o.quantity || 0));
    const returnedQty = origItems.map(() => 0.0);
    for (const r of requested) {
      const qty = Number(r.quantity || 0);
      if (qty <= 0) throw badRequest("كمية المرتجع يجب أن تكون أكبر من صفر", "INVALID_QUANTITY");
      const idxs: number[] = [];
      origItems.forEach((o, i) => { if (itemKeyMatches(o, r)) idxs.push(i); });
      if (!idxs.length) throw badRequest(`الصنف ليس ضمن الفاتورة: ${itemLabel(r)}`, "ITEM_NOT_IN_INVOICE");
      let left = qty;
      for (const i of idxs) {
        const take = Math.min(left, remainingQty[i]! - returnedQty[i]!);
        if (take > 0) {
          returnedQty[i]! += take;
          left -= take;
        }
        if (left <= EPS) break;
      }
      if (left > EPS) {
        throw badRequest(`كمية المرتجع أكبر من المتاح للإرجاع من الفاتورة: ${itemLabel(r)}`, "RETURN_EXCEEDS_SOLD");
      }
    }

    // new invoice lines after the return
    const kept: Record<string, any>[] = [];
    origItems.forEach((o, idx) => {
      const rq = returnedQty[idx]!;
      if (rq > 0) {
        restock(db, o, rq, now, {
          type: "sale_return", refType: "sales_return", refNumber: retNum, reason: `من الفاتورة #${sale.invoiceNumber}`,
        });
        returnedRecords.push({ ...o, quantity: rq, subtotal: money(rq * Number(o.sellingPrice || o.price || 0)) });
      }
      const leftQty = qtyRound(Number(o.quantity || 0) - rq);
      if (leftQty > EPS) {
        const unit = Number(o.sellingPrice || o.price || 0);
        const cost = Number(o.wholesalePrice || o.costPrice || 0);
        kept.push({ ...o, quantity: leftQty, subtotal: money(leftQty * unit), profit: money(leftQty * (unit - cost)) });
      }
    });

    const oldTotal = money(sale.total);
    const oldRemaining = money(sale.remainingDue);
    const oldPaid = money(sale.paidAmount);
    const before = {
      total: oldTotal, cost: money(sale.totalCost), profit: money(sale.totalProfit), discount: money(sale.discount), paid: oldPaid,
      qty: origItems.reduce((acc, o) => acc + Number(o.quantity || 0), 0),
    };

    let newSubtotal: number, newDiscount: number, newTotal: number, newCost: number;
    if (!kept.length) {
      newSubtotal = newDiscount = newTotal = newCost = 0.0;
    } else {
      newSubtotal = money(kept.reduce((a, i) => a + Number(i.subtotal), 0));
      const oldSubtotal = money(origItems.reduce((a, o) => a + Number(o.subtotal || 0), 0)) || money(sale.subtotal);
      newDiscount = oldSubtotal > 0 ? money((sale.discount || 0) * (newSubtotal / oldSubtotal)) : 0.0;
      newTotal = money(Math.max(0.0, newSubtotal - newDiscount));
      newCost = money(kept.reduce((a, i) => a + Number(i.wholesalePrice || i.costPrice || 0) * Number(i.quantity), 0));
    }

    refund = money(oldTotal - newTotal);
    const debtPart = money(Math.min(refund, oldRemaining));
    const cashPart = money(refund - debtPart);
    cashRefund = cashPart;
    refundMethod = sale.paymentMethod || "نقدي"; // given back the way it was paid (a credit sale's down payment: cash)

    sale.items = dumps(kept);
    sale.itemsCount = Math.trunc(kept.reduce((a, i) => a + Number(i.quantity), 0));
    sale.subtotal = newSubtotal; sale.discount = newDiscount; sale.total = newTotal; sale.totalCost = newCost;
    sale.totalProfit = kept.length ? money(newTotal - newCost) : 0.0;
    sale.remainingDue = money(oldRemaining - debtPart);
    sale.paidAmount = kept.length ? money(Math.min(Math.max(0.0, oldPaid - cashPart), newTotal)) : 0.0;
    sale.changeDue = 0.0;
    if (!kept.length) sale.status = FULL_RETURN_STATUS;
    sale.updatedAt = now;
    if (archived) {
      // the invoice only exists inside its closed day's report: that day's totals move by what was returned
      saveArchived(db, archived, sale, before, retNum, today, now);
    } else {
      saveRow(db, "sales", sale);
      // the invoice belonged to an already closed shift: that day's report must show the new totals too
      if (sale.shiftReportId) refreshReport(db, String(sale.shiftReportId), now);
    }

    // customer account
    const custId = customerId(sale.customer);
    const cust: any = custId ? getById(db, "customers", custId) : undefined;
    if (cust && refund > 0) {
      const prev = money(cust.remainingBalance);
      cust.totalPurchases = money(Math.max(0.0, (cust.totalPurchases || 0) - refund));
      cust.totalPaid = money(Math.max(0.0, (cust.totalPaid || 0) - cashPart));
      ledger.customerSetBalance(cust, Math.max(0.0, prev - debtPart));
      cust.updatedAt = now;
      ledger.appendTx(
        cust,
        ledger.makeTx(
          "ctx_ret", "مرتجع مبيعات", refund, prev, cust.remainingBalance,
          `مرتجع مبيعات #${retNum} من الفاتورة #${sale.invoiceNumber}`
            + (debtPart > 0 ? ` (تم تخفيض ${pyStr(debtPart)} ج.م من المديونية)` : ""),
          "مرتجع", { invoiceNumber: sale.invoiceNumber, returnNumber: retNum },
        ),
      );
      saveRow(db, "customers", cust);
    }

    // reverse the seller's commission proportionally to what was returned
    const seller = loadsDict(sale.sellerEmployee);
    if (seller && seller.id && refund > 0) {
      const emp: any = getById(db, "employees", String(seller.id));
      if (emp) {
        const sumOf = (type: string): number =>
          db.get<{ s: number | null }>(
            `SELECT COALESCE(SUM(amount), 0.0) AS s FROM employee_transactions WHERE invoiceNumber=? AND type=?`,
            [sale.invoiceNumber, type],
          )?.s || 0.0;
        const originalCommission = sumOf("commission");
        const previouslyReversed = sumOf("penalty");
        const share = oldTotal > 0 ? refund / oldTotal : 0.0;
        const rev = money(Math.min(
          Math.max(0.0, originalCommission - previouslyReversed),
          originalCommission ? originalCommission * share : refund * commissionRate(emp),
        ));
        if (rev > 0) {
          const month = today.slice(0, 7);
          insertRow(db, "employee_transactions", {
            id: newId(), employeeId: emp.id, employeeName: emp.name, type: "penalty", amount: rev,
            date: today, month, monthStr: month, invoiceNumber: sale.invoiceNumber,
            notes: `خصم عكس عمولة مبيعات بسبب مرتجع #${retNum} من الفاتورة #${sale.invoiceNumber}`,
            createdAt: now,
          });
        }
      }
    }
  } else {
    // A return must come from an invoice it can be checked against: returning goods with no invoice would put any
    // quantity back on the shelf (and hand out its price) without proof it was ever sold.
    throw badRequest("الفاتورة غير موجودة على هذا الجهاز. لا يمكن عمل مرتجع بدون فاتورة بيع.", "INVOICE_NOT_FOUND");
  }

  const salesReturn = {
    id: p.id || newId(),
    returnNumber: retNum,
    invoiceNumber: (p.invoiceNumber || (sale ? sale.invoiceNumber : "") || "").trim(),
    invoiceId: p.invoiceId ? String(p.invoiceId) : (sale ? sale.id : ""),
    refundedAmount: refund,
    cashRefund,
    refundMethod,
    returnedItems: dumps(returnedRecords),
    returnReason: reason,
    customer: truthy(p.customer) ? jsonField(p.customer) : (sale ? sale.customer : ""),
    cashier: truthy(p.cashier) ? jsonField(p.cashier) : (sale ? sale.cashier : ""),
    date: today,
    createdAt: p.createdAt || now,
  };
  insertRow(db, "sales_returns", salesReturn);
  return getById(db, "sales_returns", salesReturn.id)!;
}

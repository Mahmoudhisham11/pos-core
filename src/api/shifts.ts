import type { Router } from "../http/router";
import type { Ctx } from "../http/types";
import { HttpError, httpError } from "../http/errors";
import { serializeList, serializeRow } from "../http/serialize";
import * as idempotency from "../core/idempotency";
import { requireManager } from "../core/auth";
import { utcnowIso } from "../core/timeutil";
import { docNumber, dumps, money, newId, truthy, validationError } from "../domain/common";
import { buildReport, openSales, performAutoCloseShift } from "../domain/shifts";
import { computeCashFlow, openShiftStart } from "../domain/cashflow";
import { deleteRow, getById, insertRow, updateRow } from "../db/sql";
import { intQuery } from "./sales";

const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const present = (v: unknown) => v !== undefined && v !== null;

function dictBody(ctx: Ctx): Record<string, any> {
  if (!isObj(ctx.body)) {
    throw validationError([{ field: "body", message: "Input should be a valid dictionary" }]);
  }
  return ctx.body;
}

function optionalMoney(...values: unknown[]): number | null {
  for (const v of values) if (present(v)) return money(v);
  return null;
}

/** Python `str(x)` for the loose values the legacy code stringified. */
const pyText = (v: unknown): string => (typeof v === "string" ? v : String(v));

const findReport = (ctx: Ctx, id: string) =>
  ctx.db.get<any>(`SELECT * FROM shift_reports WHERE id=? OR reportNumber=? LIMIT 1`, [id, id]);

export function registerShifts(router: Router): void {
  const list = (ctx: Ctx) => {
    const date = ctx.query.date;
    const limit = intQuery(ctx, "limit", 500, 1, 5000);
    const where = date ? `WHERE (date = ? OR closedAt LIKE ? || '%')` : "";
    const params = date ? [date, date, limit] : [limit];
    return serializeList(ctx.db.all(`SELECT * FROM shift_reports ${where} ORDER BY closedAt DESC LIMIT ?`, params));
  };
  /** The open shift's money so far: what the drawer should hold now (before closing it). */
  router.get("/shifts/current-cash", (ctx) => {
    const from = openShiftStart(ctx.db);
    const flow = computeCashFlow(ctx.db, from, utcnowIso(ctx.now()));
    return { from, expectedCash: flow.cash.net, flow };
  });
  /** Money movements per channel between two moments (default: since the beginning) - the treasury's balances. */
  router.get("/finance/cashflow", (ctx) => computeCashFlow(ctx.db, ctx.query.from || null, ctx.query.to || null));
  router.get("/reports", list);
  router.get("/shifts/reports", list);
  router.get("/shifts", list);

  /**
   * Close the open shift. Totals are computed from the open invoices server-side (the client's
   * totals are ignored); the invoices are linked to the report, not deleted.
   */
  const create = (ctx: Ctx) => {
    const data = dictBody(ctx);
    const stored = idempotency.lookup(ctx);
    if (stored !== undefined) return stored;

    const now = utcnowIso(ctx.now());
    const closeSales = "clearSales" in data ? data.clearSales : true;
    const closedBy = data.closedBy || data.user || {};

    if (truthy(closeSales)) {
      const sales = openSales(ctx.db);
      if (!sales.length) {
        throw new HttpError(400, { error_code: "NO_OPEN_SALES", message: "لا توجد فواتير مبيعات مسجلة في الوردية الحالية لتقفيلها.", details: {} });
      }
      const report = buildReport(ctx.db, sales, {
        reportNumber: data.reportNumber || docNumber("REP", now.slice(0, 10)),
        closedBy,
        notes: "notes" in data ? data.notes : "",
        shiftDate: data.date,
        openingCash: money(data.openingCash || data.opening_cash || 0.0),
        closingCashActual: optionalMoney(data.closingCashActual, data.closing_cash_actual),
        // expenses of the shift come from the books unless the caller states them
        totalExpenses: (data.totalExpenses ?? data.total_expenses) != null ? money(data.totalExpenses ?? data.total_expenses) : undefined,
        totalPurchases: money(data.totalPurchases || data.total_purchases || 0.0),
        reportId: data.id,
        closedAt: now,
      });
      return idempotency.recordResult(ctx, serializeRow(report));
    }

    // Manual archive of a report without touching the open invoices
    const invoices = "invoices" in data ? data.invoices : [];
    const payments = data.payments || data.paymentBreakdown || {};
    const row = {
      id: data.id || newId(),
      reportNumber: data.reportNumber || docNumber("REP", now.slice(0, 10)),
      closedAt: data.closedAt || now,
      closedBy: Array.isArray(closedBy) || isObj(closedBy) ? dumps(closedBy) : (closedBy ? pyText(closedBy) : ""),
      date: data.date || now.slice(0, 10),
      openingCash: money(data.openingCash || 0.0),
      closingCashActual: money(data.closingCashActual || 0.0),
      closingCashExpected: money(data.closingCashExpected || 0.0),
      totalSales: money(data.totalSales || 0.0),
      totalProfit: money(data.totalProfit || 0.0),
      totalCost: money(data.totalCost || 0.0),
      totalPaid: money(data.totalPaid || 0.0),
      totalDiscount: money(data.totalDiscount || 0.0),
      totalExpenses: money(data.totalExpenses || 0.0),
      totalPurchases: money(data.totalPurchases || 0.0),
      totalItemsSold: money(data.totalItemsSold || 0.0),
      invoicesCount: Math.trunc(Number(data.invoicesCount || (Array.isArray(invoices) ? invoices.length : 0))),
      invoices: Array.isArray(invoices) ? dumps(invoices) : pyText(invoices),
      paymentBreakdown: isObj(payments) ? dumps(payments) : pyText(payments),
      notes: "notes" in data ? data.notes : "",
      createdAt: data.createdAt || now,
    };
    insertRow(ctx.db, "shift_reports", row);
    return idempotency.recordResult(ctx, serializeRow(getById(ctx.db, "shift_reports", row.id)));
  };
  router.post("/reports", create);
  router.post("/shifts/reports", create);
  router.post("/shifts/close", create);

  router.get("/reports/{report_id}", (ctx) => {
    const rep = findReport(ctx, ctx.params.report_id!);
    if (!rep) throw httpError(404, "التقرير غير موجود");
    return serializeRow(rep);
  });

  router.put("/reports/{report_id}", (ctx) => {
    const data = dictBody(ctx);
    requireManager(ctx);
    const rep = findReport(ctx, ctx.params.report_id!);
    if (!rep) throw httpError(404, "التقرير غير موجود");

    const patch: Record<string, unknown> = {};
    const numeric = ["totalSales", "totalProfit", "totalCost", "totalPaid", "totalDiscount", "totalExpenses", "totalPurchases", "totalItemsSold"];
    for (const field of numeric) if (present(data[field])) patch[field] = money(data[field]);
    if (present(data.invoicesCount)) patch.invoicesCount = Math.trunc(Number(data.invoicesCount));
    if (present(data.notes)) patch.notes = pyText(data.notes);
    if (present(data.invoices)) patch.invoices = Array.isArray(data.invoices) ? dumps(data.invoices) : pyText(data.invoices);
    if (present(data.paymentBreakdown)) patch.paymentBreakdown = isObj(data.paymentBreakdown) ? dumps(data.paymentBreakdown) : pyText(data.paymentBreakdown);

    updateRow(ctx.db, "shift_reports", rep.id, patch);
    return serializeRow(getById(ctx.db, "shift_reports", rep.id));
  });

  router.delete("/reports/{report_id}", (ctx) => {
    requireManager(ctx);
    const rep = findReport(ctx, ctx.params.report_id!);
    if (rep) deleteRow(ctx.db, "shift_reports", rep.id);
    return { success: true, message: "تم حذف التقرير" };
  });

  router.post("/shifts/auto-close-trigger", (ctx) => {
    requireManager(ctx);
    const reports = performAutoCloseShift(ctx.db, ctx.now());
    if (reports.length) return { success: true, message: "تم التقفيل التلقائي بنجاح", report: reports[0], reports };
    return { success: true, message: "لا توجد فواتير من أيام سابقة تحتاج للتقفيل" };
  });
}

/** Shift closing: builds the report from the open invoices and *links* them to it (never deletes them). */
import type { SqlDriver } from "../db/types";
import { getById, insertRow, updateRow } from "../db/sql";
import { cairoDateStr, utcnowIso, endOfCairoDay } from "../core/timeutil";
import { serializeRow } from "../http/serialize";
import { dumps, loadsList, money, newId } from "./common";
import { computeCashFlow, openShiftStart } from "./cashflow";
import { cashMethod, methodNames } from "../core/payments";

export function openSales(db: SqlDriver): any[] {
  return db.all(`SELECT * FROM sales WHERE shiftReportId IS NULL ORDER BY createdAt ASC`);
}

export interface BuildReportOpts {
  reportNumber: string;
  closedBy: unknown;
  notes?: string;
  shiftDate?: string | null;
  openingCash?: number;
  closingCashActual?: number | null;
  totalExpenses?: number;
  totalPurchases?: number;
  reportId?: string | null;
  closedAt?: string | null;
  /** Start of the period whose money movements make the expected drawer cash (default: the open shift's start). */
  cashFrom?: string | null;
}

export function buildReport(db: SqlDriver, sales: any[], o: BuildReportOpts): any {
  const openingCash = o.openingCash ?? 0.0;
  const now0 = o.closedAt || utcnowIso();
  // Expected drawer = opening float + every cash movement of the shift (sales, returns, collections, expenses,
  // supplier payments, advances, treasury) - see domain/cashflow.ts
  const cash = computeCashFlow(db, o.cashFrom !== undefined ? o.cashFrom : openShiftStart(db), now0).cash;
  const totalExpenses = o.totalExpenses ?? cash.byKind.expenses;
  const totals = { sales: 0, cost: 0, profit: 0, discount: 0, paid: 0 };
  const breakdown: Record<string, number> = {};
  for (const m of methodNames()) breakdown[m] = 0.0;
  const invoices: any[] = [];
  let itemsSold = 0.0;

  for (const s of sales) {
    invoices.push(serializeRow(s));
    totals.sales += s.total || 0.0;
    totals.cost += s.totalCost || 0.0;
    totals.profit += s.totalProfit || 0.0;
    totals.discount += s.discount || 0.0;
    totals.paid += s.paidAmount || 0.0;
    const method = s.paymentMethod || cashMethod();
    breakdown[method] = (breakdown[method] ?? 0.0) + (s.total || 0.0);
    const lines = loadsList(s.items);
    itemsSold += lines.length ? lines.reduce((a, i) => a + Number(i.quantity || 0), 0) : 0.0;
  }

  const expectedCash = money(openingCash + cash.net);
  const now = now0;
  const report = {
    id: o.reportId || newId(),
    reportNumber: o.reportNumber,
    closedAt: now,
    closedBy: typeof o.closedBy === "string" ? o.closedBy : dumps(o.closedBy || {}),
    date: o.shiftDate || cairoDateStr(now) || now.slice(0, 10),
    openingCash: money(openingCash),
    closingCashActual: money(o.closingCashActual !== null && o.closingCashActual !== undefined ? o.closingCashActual : expectedCash),
    closingCashExpected: expectedCash,
    totalSales: money(totals.sales),
    totalProfit: money(totals.profit),
    totalCost: money(totals.cost),
    totalPaid: money(totals.paid),
    totalDiscount: money(totals.discount),
    totalExpenses: money(totalExpenses),
    totalPurchases: money(o.totalPurchases ?? 0.0),
    totalItemsSold: money(itemsSold),
    invoicesCount: invoices.length,
    invoices: dumps(invoices),
    paymentBreakdown: dumps(Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, money(v)]))),
    notes: o.notes || "",
    createdAt: now,
  };
  if (getById(db, "shift_reports", report.id)) {
    const { id, ...patch } = report;
    updateRow(db, "shift_reports", id, patch);
  } else {
    insertRow(db, "shift_reports", report);
  }
  for (const s of sales) if (s.shiftReportId !== report.id) updateRow(db, "sales", s.id, { shiftReportId: report.id, updatedAt: now });
  return getById(db, "shift_reports", report.id)!;
}

/**
 * Re-totals a closed shift report from its invoices as they are NOW. A return made after the shift was closed changes
 * the invoice; without this the day's report (and every figure built on reports: month profit, reports page) would
 * keep the old, too-high numbers. The drawer figures of the closing moment (opening / expected / counted cash) are a
 * historical count and stay as they were.
 */
export function refreshReport(db: SqlDriver, reportId: string, nowIso: string): void {
  const report = getById<any>(db, "shift_reports", reportId);
  if (!report) return;
  const sales = db.all<any>(`SELECT * FROM sales WHERE shiftReportId=? ORDER BY createdAt ASC`, [reportId]);
  const totals = { sales: 0, cost: 0, profit: 0, discount: 0, paid: 0 };
  const breakdown: Record<string, number> = {};
  for (const m of methodNames()) breakdown[m] = 0.0;
  let itemsSold = 0;
  for (const s of sales) {
    totals.sales += s.total || 0;
    totals.cost += s.totalCost || 0;
    totals.profit += s.totalProfit || 0;
    totals.discount += s.discount || 0;
    totals.paid += s.paidAmount || 0;
    const method = s.paymentMethod || cashMethod();
    breakdown[method] = (breakdown[method] ?? 0) + (s.total || 0);
    itemsSold += loadsList(s.items).reduce((a, i) => a + Number(i.quantity || 0), 0);
  }
  updateRow(db, "shift_reports", reportId, {
    totalSales: money(totals.sales),
    totalCost: money(totals.cost),
    totalProfit: money(totals.profit),
    totalDiscount: money(totals.discount),
    totalPaid: money(totals.paid),
    totalItemsSold: money(itemsSold),
    invoicesCount: sales.length,
    invoices: dumps(sales.map((s) => serializeRow(s))),
    paymentBreakdown: dumps(Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, money(v)]))),
    notes: report.notes,
  });
  void nowIso;
}

/**
 * Close every open invoice that belongs to a Cairo calendar day before today (one report per day).
 *
 * Called by the midnight scheduler and again at start-up, so a shift is still closed when the app was
 * switched off at 12:00 AM.
 */
export function closeStaleShifts(db: SqlDriver, nowDate: Date = new Date()): any[] {
  const today = cairoDateStr(nowDate)!;
  const byDay = new Map<string, any[]>();
  for (const s of openSales(db)) {
    const day = cairoDateStr(s.createdAt) || (s.date || "").slice(0, 10) || today;
    if (day < today) {
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(s);
    }
  }

  const reports: any[] = [];
  for (const day of [...byDay.keys()].sort()) {
    // One automatic report per day for the whole shop: every device builds it under the same id, so devices that
    // close the same day (each at its own midnight) update ONE report instead of creating duplicates. A report that
    // already came from another device keeps its invoices and gets this device's remaining ones added.
    const reportId = `auto-${day}`;
    const linked = db.all<any>(`SELECT * FROM sales WHERE shiftReportId=?`, [reportId]);
    reports.push(buildReport(db, [...linked, ...byDay.get(day)!], {
      reportId,
      reportNumber: `REP-${day.replace(/-/g, "")}-AUTO`,
      closedBy: { name: "تقفيل تلقائي (النظام)", email: "system@auto", role: "SYSTEM" },
      notes: "تم التقفيل التلقائي المجدول للوردية عند منتصف الليل بتوقيت القاهرة",
      shiftDate: day,
      // Stamped at the very end of the closed day (23:59:59 Cairo) so the report never lands on the next date.
      closedAt: utcnowIso(endOfCairoDay(day)),
      // the money of that whole day (just after the previous day's end)
      cashFrom: utcnowIso(new Date(endOfCairoDay(day).getTime() - 86_399_000)),
    }));
  }
  return reports;
}

/** Close all open invoices that belong to a day before today (Cairo). Safe to call at any time; returns the serialized reports. */
export function performAutoCloseShift(db: SqlDriver, now: Date = new Date()): any[] {
  try {
    return db.transaction(() => {
      const reports = closeStaleShifts(db, now);
      if (!reports.length) return [];
      return reports.map((r) => serializeRow(r));
    });
  } catch (e) {
    console.error("Error during auto-closing shift", e);
    return [];
  }
}

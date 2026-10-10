import type { Router } from "../http/router";
import type { Ctx } from "../http/types";
import { httpError } from "../http/errors";
import { serializeList, serializeRow } from "../http/serialize";
import * as idempotency from "../core/idempotency";
import { requireManager } from "../core/auth";
import { createReturn, createSale, parseReturnIn, parseSaleIn, voidSale } from "../domain/sales";
import { validationError } from "../domain/common";

/** FastAPI Query(default, ge=, le=) for an int. */
export function intQuery(ctx: Ctx, name: string, dflt: number, ge: number, le: number): number {
  const raw = ctx.query[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n)) {
    throw validationError([{ field: `query -> ${name}`, message: "Input should be a valid integer, unable to parse string as an integer" }]);
  }
  if (n < ge) throw validationError([{ field: `query -> ${name}`, message: `Input should be greater than or equal to ${ge}` }]);
  if (n > le) throw validationError([{ field: `query -> ${name}`, message: `Input should be less than or equal to ${le}` }]);
  return n;
}

export function boolQuery(ctx: Ctx, name: string, dflt = false): boolean {
  const raw = ctx.query[name];
  if (raw === undefined) return dflt;
  const s = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on", "t", "y"].includes(s)) return true;
  if (["false", "0", "no", "off", "f", "n"].includes(s)) return false;
  throw validationError([{ field: `query -> ${name}`, message: "Input should be a valid boolean, unable to interpret input" }]);
}

const findSale = (ctx: Ctx, id: string) =>
  ctx.db.get<any>(`SELECT * FROM sales WHERE id=? OR invoiceNumber=? LIMIT 1`, [id, id]);

export function registerSales(router: Router): void {
  // =====================================================================
  // Sales / POS Invoices (the list is the *open shift*; closed invoices live in shift reports)
  // =====================================================================
  router.get("/sales", (ctx) => {
    const date = ctx.query.date;
    const includeClosed = boolQuery(ctx, "includeClosed");
    const limit = intQuery(ctx, "limit", 5000, 1, 10000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (!includeClosed) where.push(`shiftReportId IS NULL`);
    if (date) { where.push(`(date = ? OR createdAt LIKE ? || '%')`); params.push(date, date); }
    const sql = `SELECT * FROM sales ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY createdAt DESC LIMIT ?`;
    return serializeList(ctx.db.all(sql, [...params, limit]));
  });

  router.post("/sales", (ctx) => {
    const data = parseSaleIn(ctx.body); // body validation runs before the handler, as in FastAPI
    const stored = idempotency.lookup(ctx);
    if (stored !== undefined) return stored;
    const sale = createSale(ctx.db, data, ctx.now());
    return idempotency.recordResult(ctx, serializeRow(sale));
  });

  router.get("/sales/{sale_id}", (ctx) => {
    const sale = findSale(ctx, ctx.params.sale_id!);
    if (!sale) throw httpError(404, "الفاتورة غير موجودة");
    return serializeRow(sale);
  });

  router.delete("/sales/{sale_id}", (ctx) => {
    requireManager(ctx);
    const sale = findSale(ctx, ctx.params.sale_id!);
    if (sale) voidSale(ctx.db, sale, ctx.now());
    return { success: true, message: "تم حذف الفاتورة" };
  });

  // =====================================================================
  // Sales Returns
  // =====================================================================
  // NOTE (legacy quirk preserved): GET /sales/returns is declared after GET /sales/{sale_id}, which shadows it (-> 404); /returns works.
  const listReturns = (ctx: Ctx) =>
    serializeList(ctx.db.all(`SELECT * FROM sales_returns ORDER BY createdAt DESC LIMIT 500`));
  router.get("/returns", listReturns);
  router.get("/sales/returns", listReturns);

  const postReturn = (ctx: Ctx) => {
    const data = parseReturnIn(ctx.body);
    const stored = idempotency.lookup(ctx);
    if (stored !== undefined) return stored;
    const ret = createReturn(ctx.db, data, ctx.now());
    return idempotency.recordResult(ctx, serializeRow(ret));
  };
  router.post("/returns", postReturn);
  router.post("/sales/returns", postReturn);
}

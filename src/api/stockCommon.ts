/** Shared helpers of the products / shop endpoints (identical list + CRUD logic for both product tables). */
import { requireManager } from "../core/auth";
import { Validation, applyUpdate, addOrRestock, bodyObject, parseProductIn } from "../domain/catalog";
import { httpError } from "../http/errors";
import { serializeList, serializeRow } from "../http/serialize";
import { getById, deleteRow } from "../db/sql";
import { logMovement } from "../domain/stock";
import type { Router } from "../http/router";
import type { Ctx } from "../http/types";

/** `limit: int = Query(5000, ge=1, le=10000)` */
export function parseLimit(ctx: Ctx): number {
  const raw = ctx.query.limit;
  if (raw === undefined) return 5000;
  const v = new Validation(["query"]);
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) v.add(["limit"], "Input should be a valid integer, unable to parse string as an integer");
  else {
    const n = Number(raw.trim());
    if (n < 1) v.add(["limit"], "Input should be greater than or equal to 1");
    else if (n > 10000) v.add(["limit"], "Input should be less than or equal to 10000");
    else return n;
  }
  v.check();
  return 5000;
}

type Table = "products" | "shop_products";

/** Registers list/add/get/update/delete under `prefix` (relative to the API root). */
export function registerProductCrud(router: Router, prefix: string, table: Table, o: {
  defaultThreshold: number; notFoundGet: string; notFoundMutate: string; deleted: string;
}): void {
  router.get(prefix, (ctx) => {
    const limit = parseLimit(ctx);
    const where: string[] = [];
    const args: unknown[] = [];
    const { search, category, groupId } = ctx.query;
    if (search) {
      where.push("(LOWER(name) LIKE LOWER(?) OR LOWER(barcode) LIKE LOWER(?))");
      const s = `%${search.trim()}%`;
      args.push(s, s);
    }
    if (category && category !== "all") { where.push("category = ?"); args.push(category); }
    if (groupId) { where.push(`"groupId" = ?`); args.push(groupId); }
    const sql = `SELECT * FROM "${table}"${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY name ASC LIMIT ?`;
    return serializeList(ctx.db.all(sql, [...args, limit]));
  });

  router.post(prefix, (ctx) => {
    const data = parseProductIn(ctx.body);
    return serializeRow(addOrRestock(ctx.db, table, data, o.defaultThreshold, ctx.now().toISOString()));
  });

  router.get(`${prefix}/{product_id}`, (ctx) => {
    const prod = getById(ctx.db, table, ctx.params.product_id!);
    if (!prod) throw httpError(404, o.notFoundGet);
    return serializeRow(prod);
  });

  const update = (ctx: Ctx) => {
    const data = bodyObject(ctx.body);
    const prod = getById(ctx.db, table, ctx.params.product_id!);
    if (!prod) throw httpError(404, o.notFoundMutate);
    applyUpdate(ctx.db, table, prod, data, ctx.now().toISOString());
    return serializeRow(getById(ctx.db, table, prod.id));
  };
  router.put(`${prefix}/{product_id}`, update);
  router.patch(`${prefix}/{product_id}`, update);

  router.delete(`${prefix}/{product_id}`, (ctx) => {
    requireManager(ctx);
    const prod = getById(ctx.db, table, ctx.params.product_id!);
    if (!prod) throw httpError(404, o.notFoundMutate);
    deleteRow(ctx.db, table, prod.id);
    logMovement(ctx.db, table, prod, prod.quantity || 0, 0, { type: "deleted" }, ctx.now().toISOString());
    return { success: true, message: o.deleted };
  });
}

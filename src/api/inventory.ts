import { requireManager } from "../core/auth";
import { Validation, bodyObject, floatField, strField } from "../domain/catalog";
import { findShopProduct, findWarehouseProduct, newId, qtyRound } from "../domain/common";
import { MOVEMENT_LABELS, logMovement } from "../domain/stock";
import { updateRow } from "../db/sql";
import { HttpError } from "../http/errors";
import type { Router } from "../http/router";
import { parseLimit } from "./stockCommon";

const WAREHOUSE_LOCATION = "loc-wh-01";
const SHOP_LOCATION = "loc-shop-01";

/** /inventory - stock levels per location and stock-take adjustments. */
export function registerInventory(router: Router): void {
  router.get("/inventory", (ctx) => {
    const limit = parseLimit(ctx);
    const wh = ctx.query.location_id === WAREHOUSE_LOCATION;
    const rows = ctx.db.all<any>(`SELECT id, quantity FROM "${wh ? "products" : "shop_products"}" LIMIT ?`, [limit]);
    const loc = wh ? WAREHOUSE_LOCATION : SHOP_LOCATION;
    return rows.map((p) => ({ id: p.id, product_id: p.id, location_id: loc, quantity: p.quantity }));
  });

  router.post("/inventory/adjustments", (ctx) => {
    requireManager(ctx);
    // Stock-take correction: sets the counted quantity (applied immediately and logged as a stock movement).
    const raw = bodyObject(ctx.body);
    const v = new Validation();
    const productId = strField(v, raw, "productId");
    const barcode = strField(v, raw, "barcode", { def: "" });
    const locationId = strField(v, raw, "location_id", { def: SHOP_LOCATION });
    const newQuantity = floatField(v, raw, "newQuantity", { ge: 0, required: true });
    const reason = strField(v, raw, "reason", { def: "" });
    v.check();

    const inWarehouse = locationId === WAREHOUSE_LOCATION;
    const finder = inWarehouse ? findWarehouseProduct : findShopProduct;
    const prod = finder(ctx.db, barcode, productId);
    if (prod === undefined) {
      throw new HttpError(404, { error_code: "PRODUCT_NOT_FOUND", message: "الصنف غير موجود", details: {} });
    }
    const before = prod.quantity;
    const quantity = qtyRound(newQuantity!);
    const table = inWarehouse ? "products" : "shop_products";
    const now = ctx.now().toISOString();
    // a counted quantity is synced as that value, never as a difference from this device's (possibly stale) copy
    updateRow(ctx.db, table, prod.id, { quantity, updatedAt: now }, { absolute: ["quantity"] });
    logMovement(ctx.db, table, prod, before, quantity, { type: "adjustment", reason: reason || "جرد" }, now);
    return {
      id: newId(), status: "COMPLETED", productId: prod.id, location_id: locationId,
      previousQuantity: before, newQuantity: quantity, reason: reason || "",
    };
  });

  // Stock movement log, newest first. Filters: productId (or barcode), location (shop | warehouse), type, from/to (dates).
  router.get("/inventory/movements", (ctx) => {
    const limit = parseLimit(ctx);
    const { productId, barcode, location, type, from, to } = ctx.query;
    const where: string[] = [];
    const args: unknown[] = [];
    if (productId && barcode) { where.push(`("productId" = ? OR ("barcode" = ? AND "barcode" != ''))`); args.push(productId, barcode); }
    else if (productId) { where.push(`"productId" = ?`); args.push(productId); }
    else if (barcode) { where.push(`"barcode" = ?`); args.push(barcode); }
    if (location === "shop" || location === "warehouse") { where.push(`"location" = ?`); args.push(location); }
    if (type) { where.push(`"type" = ?`); args.push(type); }
    if (from) { where.push(`"createdAt" >= ?`); args.push(from); }
    if (to) { where.push(`"createdAt" < ?`); args.push(to.length === 10 ? `${to}T99` : to); } // a bare date includes that whole day
    const rows = ctx.db.all<any>(
      `SELECT * FROM stock_movements ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY "createdAt" DESC, rowid DESC LIMIT ?`,
      [...args, limit],
    );
    return rows.map((r) => ({ ...r, typeLabel: MOVEMENT_LABELS[r.type as keyof typeof MOVEMENT_LABELS] ?? r.type }));
  });

  router.post("/inventory/adjustments/{adj_id}/complete", (ctx) => {
    requireManager(ctx);
    // Adjustments are applied when created; kept for API compatibility.
    return { id: ctx.params.adj_id, status: "COMPLETED" };
  });
}

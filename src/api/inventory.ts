import { requireManager } from "../core/auth";
import { Validation, bodyObject, floatField, strField } from "../domain/catalog";
import { findShopProduct, findWarehouseProduct, newId, qtyRound } from "../domain/common";
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
    // Stock-take correction: sets the counted quantity (applied immediately, synced like any stock change).
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
    const quantity = qtyRound(newQuantity);
    updateRow(ctx.db, inWarehouse ? "products" : "shop_products", prod.id, { quantity, updatedAt: ctx.now().toISOString() });
    return {
      id: newId(), status: "COMPLETED", productId: prod.id, location_id: locationId,
      previousQuantity: before, newQuantity: quantity, reason: reason || "",
    };
  });

  router.post("/inventory/adjustments/{adj_id}/complete", (ctx) => {
    requireManager(ctx);
    // Adjustments are applied when created; kept for API compatibility.
    return { id: ctx.params.adj_id, status: "COMPLETED" };
  });
}

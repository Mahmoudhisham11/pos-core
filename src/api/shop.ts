import * as idempotency from "../core/idempotency";
import {
  createPurchase, createPurchaseReturn, createTransfer, parsePurchaseIn, parsePurchaseReturnIn, parseTransferIn,
} from "../domain/purchases";
import { serializeList, serializeRow } from "../http/serialize";
import type { Router } from "../http/router";
import type { Ctx } from "../http/types";
import { registerProductCrud } from "./stockCommon";

/** Idempotent create: replay the stored response for a repeated Idempotency-Key, otherwise run and record. */
function idempotent(ctx: Ctx, run: () => Record<string, any>) {
  const stored = idempotency.lookup(ctx);
  if (stored !== undefined) return stored;
  return idempotency.recordResult(ctx, serializeRow(run()));
}

/** /shop - shop products, transfers, purchases & purchase returns. */
export function registerShop(router: Router): void {
  registerProductCrud(router, "/shop/products", "shop_products", {
    defaultThreshold: 3,
    notFoundGet: "المنتج غير موجود",
    notFoundMutate: "المنتج غير موجود",
    deleted: "تم حذف الصنف من المحل",
  });

  router.get("/shop/transfers", (ctx) =>
    serializeList(ctx.db.all(`SELECT * FROM transfers ORDER BY createdAt DESC LIMIT 200`)));
  router.post("/shop/transfers", (ctx) => {
    const data = parseTransferIn(ctx.body);
    return idempotent(ctx, () => createTransfer(ctx.db, data, ctx.now().toISOString()));
  });

  router.get("/shop/purchases", (ctx) =>
    serializeList(ctx.db.all(`SELECT * FROM shop_purchases ORDER BY createdAt DESC LIMIT 200`)));
  router.post("/shop/purchases", (ctx) => {
    const data = parsePurchaseIn(ctx.body);
    return idempotent(ctx, () => createPurchase(ctx.db, data, ctx.now().toISOString()));
  });

  router.get("/shop/purchase-returns", (ctx) =>
    serializeList(ctx.db.all(`SELECT * FROM shop_purchase_returns ORDER BY createdAt DESC LIMIT 200`)));
  router.post("/shop/purchase-returns", (ctx) => {
    const data = parsePurchaseReturnIn(ctx.body);
    return idempotent(ctx, () => createPurchaseReturn(ctx.db, data, ctx.now().toISOString()));
  });
}

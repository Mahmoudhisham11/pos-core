import { expect } from "vitest";
import type { makeApp } from "./helpers";

type App = ReturnType<typeof makeApp>;

export async function addShopProduct(app: App, token: string, o: { name?: string; qty?: number; price?: number; cost?: number; barcode?: string } = {}) {
  const { name = "Lipstick", qty = 10, price = 100.0, cost = 60.0, barcode = "111" } = o;
  const res = await app.call("POST", "/api/shop/products",
    { name, barcode, quantity: qty, sellingPrice: price, wholesalePrice: cost, costPrice: cost }, { token });
  expect(res.status).toBe(200);
  return res.body;
}

export function salePayload(product: any, qty = 1, extra: Record<string, any> = {}) {
  return {
    items: [{ productId: product.id, barcode: product.barcode ?? "", name: product.name, quantity: qty, sellingPrice: product.sellingPrice }],
    paymentMethod: "نقدي",
    ...extra,
  };
}

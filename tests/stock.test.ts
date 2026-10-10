import { beforeEach, describe, expect, it } from "vitest";
import { login, makeApp } from "./helpers";

type App = Awaited<ReturnType<typeof makeApp>>;
let app: App;
let tok: string;
const A = () => ({ token: tok });

beforeEach(async () => {
  app = await makeApp();
  tok = await login(app);
});

async function addShopProduct(over: Record<string, any> = {}) {
  const { name = "Lipstick", qty = 10, price = 100.0, cost = 60.0, barcode = "111" } = over;
  const res = await app.call("POST", "/api/shop/products",
    { name, barcode, quantity: qty, sellingPrice: price, wholesalePrice: cost, costPrice: cost }, A());
  expect(res.status).toBe(200);
  return res.body;
}

describe("stock movements", () => {
  it("transfer requires source stock", async () => {
    const wh = (await app.call("POST", "/api/products", { name: "Cream", barcode: "c1", quantity: 5, sellingPrice: 20, wholesalePrice: 10 }, A())).body;
    const body = { productId: wh.id, productName: "Cream", barcode: "c1", quantity: 3, direction: "to_shop" };
    expect((await app.call("POST", "/api/shop/transfers", body, A())).status).toBe(200);
    expect((await app.call("GET", `/api/products/${wh.id}`, undefined, A())).body.quantity).toBe(2);
    const shopList = async () => (await app.call("GET", "/api/shop/products", undefined, A())).body.filter((p: any) => p.barcode === "c1");
    let shop = await shopList();
    expect(shop.length).toBe(1);
    expect(shop[0].quantity).toBe(3);

    const tooMany = await app.call("POST", "/api/shop/transfers", { ...body, quantity: 9 }, A());
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error_code).toBe("INSUFFICIENT_STOCK");

    const ghost = await app.call("POST", "/api/shop/transfers", { productName: "Nope", barcode: "nope", quantity: 1, direction: "to_shop" }, A());
    expect(ghost.status).toBe(400); // no stock is created out of thin air

    // a second transfer reuses the shop product instead of duplicating it
    await app.call("POST", "/api/shop/transfers", { ...body, quantity: 1 }, A());
    shop = await shopList();
    expect(shop.length).toBe(1);
    expect(shop[0].quantity).toBe(4);
  });

  it("transfer back to the warehouse and invalid direction", async () => {
    await addShopProduct({ barcode: "s9", qty: 4 });
    const back = await app.call("POST", "/api/shop/transfers", { barcode: "s9", quantity: 3, direction: "to_warehouse" }, A());
    expect(back.status).toBe(200);
    expect(back.body.direction).toBe("to_warehouse");
    const wh = (await app.call("GET", "/api/products", undefined, A())).body.filter((p: any) => p.barcode === "s9");
    expect(wh.length).toBe(1);
    expect(wh[0].quantity).toBe(3);
    expect((await app.call("POST", "/api/shop/transfers", { barcode: "s9", quantity: 1, direction: "sideways" }, A())).body.error_code).toBe("VALIDATION_ERROR");
    expect((await app.call("GET", "/api/shop/transfers", undefined, A())).body.length).toBe(1);
  });

  it("purchase updates stock, supplier and weighted cost", async () => {
    const p = await addShopProduct({ qty: 10, cost: 10, price: 30, barcode: "p1" });
    const sup = (await app.call("POST", "/api/suppliers", { name: "Acme" }, A())).body;
    const body = {
      supplier: { id: sup.id, name: "Acme" },
      items: [{ barcode: "p1", name: "Lipstick", quantity: 10, costPrice: 20 }],
      paidAmount: 50,
    };
    const res = await app.call("POST", "/api/shop/purchases", body, A());
    expect(res.status).toBe(200);
    expect(res.body.totalCost).toBe(200);
    expect(res.body.remainingDue).toBe(150);

    const prod = (await app.call("GET", `/api/shop/products/${p.id}`, undefined, A())).body;
    expect(prod.quantity).toBe(20);
    expect(prod.wholesalePrice).toBe(15); // (10*10 + 10*20) / 20
    const s = (await app.call("GET", `/api/suppliers/${sup.id}`, undefined, A())).body;
    expect(s.remainingBalance).toBe(150);
    expect(s.totalPurchases).toBe(200);
    expect(s.transactions.at(-1).notes).toContain("(مدفوع: 50.0 ج.م، متبقي: 150.0 ج.م)");

    // purchase on credit without a supplier is refused
    const bad = await app.call("POST", "/api/shop/purchases", { items: [{ barcode: "p1", name: "Lipstick", quantity: 1, costPrice: 5 }], paidAmount: 0 }, A());
    expect(bad.status).toBe(400);
    expect(bad.body.error_code).toBe("SUPPLIER_REQUIRED");
  });

  it("purchase creates unknown products and replays by Idempotency-Key", async () => {
    const headers = { "idempotency-key": "pur-1" };
    const body = { items: [{ barcode: "n1", name: "Brand New", quantity: 2, costPrice: 5, sellingPrice: 9 }], paidAmount: 10 };
    const first = await app.call("POST", "/api/shop/purchases", body, { token: tok, headers });
    expect(first.status).toBe(200);
    const again = await app.call("POST", "/api/shop/purchases", body, { token: tok, headers });
    expect(again.body.id).toBe(first.body.id);
    const list = (await app.call("GET", "/api/shop/products", undefined, A())).body.filter((p: any) => p.barcode === "n1");
    expect(list.length).toBe(1);
    expect(list[0].quantity).toBe(2);
    expect(list[0].sellingPrice).toBe(9);
    expect((await app.call("GET", "/api/shop/purchases", undefined, A())).body.length).toBe(1);
    // invalid payloads
    expect((await app.call("POST", "/api/shop/purchases", { items: [] }, A())).status).toBe(422);
    expect((await app.call("POST", "/api/shop/purchases", { items: [{ barcode: "z", quantity: 1 }], paidAmount: 99 }, A())).body.error_code).toBe("INVALID_AMOUNT");
  });

  it("purchase return validates and reduces supplier debt", async () => {
    await addShopProduct({ qty: 0, cost: 10, barcode: "r1" });
    const sup = (await app.call("POST", "/api/suppliers", { name: "Beta" }, A())).body;
    const purchase = (await app.call("POST", "/api/shop/purchases", {
      supplier: { id: sup.id }, items: [{ barcode: "r1", name: "Lipstick", quantity: 10, costPrice: 10 }], paidAmount: 0 }, A())).body;

    const ok = await app.call("POST", "/api/shop/purchase-returns", {
      invoiceId: purchase.id, supplier: { id: sup.id }, returnedItems: [{ barcode: "r1", name: "Lipstick", quantity: 4 }] }, A());
    expect(ok.status).toBe(200);
    expect(ok.body.totalRefund).toBe(40);
    expect((await app.call("GET", `/api/suppliers/${sup.id}`, undefined, A())).body.remainingBalance).toBe(60);

    const tooMany = await app.call("POST", "/api/shop/purchase-returns", {
      invoiceId: purchase.id, supplier: { id: sup.id }, returnedItems: [{ barcode: "r1", name: "Lipstick", quantity: 7 }] }, A());
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error_code).toBe("RETURN_EXCEEDS_PURCHASED");
    expect((await app.call("GET", "/api/shop/purchase-returns", undefined, A())).body.length).toBe(1);
  });
});

describe("catalogue", () => {
  it("product validation and barcode uniqueness", async () => {
    const neg = await app.call("POST", "/api/shop/products", { name: "Neg", quantity: -1 }, A());
    expect(neg.status).toBe(422);
    expect(neg.body.error_code).toBe("VALIDATION_ERROR");
    expect(neg.body.errors[0].field).toBe("body -> quantity");
    const a = await addShopProduct({ name: "A", barcode: "dup" });
    const b = await addShopProduct({ name: "B", barcode: "other" });
    const res = await app.call("PUT", `/api/shop/products/${b.id}`, { barcode: "dup" }, A());
    expect(res.status).toBe(409);
    expect(res.body.error_code).toBe("DUPLICATE_BARCODE");
    expect((await app.call("PUT", `/api/shop/products/${a.id}`, { sellingPrice: -5 }, A())).status).toBe(400);
  });

  it("adding an existing barcode restocks it; list filters and limits", async () => {
    await app.call("POST", "/api/products", { name: "Soap", barcode: "w1", quantity: 2, sellingPrice: 10, costPrice: 4 }, A());
    const again = (await app.call("POST", "/api/products", { name: "Soap", barcode: "w1", quantity: 3, sellingPrice: 12 }, A())).body;
    expect(again.quantity).toBe(5);
    expect(again.sellingPrice).toBe(12);
    expect(again.minThreshold).toBe(5);
    await app.call("POST", "/api/products", { name: "Shampoo", barcode: "w2", category: "hair" }, A());
    const all = (await app.call("GET", "/api/products", undefined, A())).body;
    expect(all.map((p: any) => p.name)).toEqual(["Shampoo", "Soap"]);
    expect((await app.call("GET", "/api/products?search=SOA", undefined, A())).body.length).toBe(1);
    expect((await app.call("GET", "/api/products?category=hair", undefined, A())).body.length).toBe(1);
    expect((await app.call("GET", "/api/products?category=all&limit=1", undefined, A())).body.length).toBe(1);
    expect((await app.call("GET", "/api/products?limit=0", undefined, A())).status).toBe(422);
    expect((await app.call("GET", "/api/products/nope", undefined, A())).body).toEqual({ detail: "المنتج غير موجود في المخزن" });
    expect((await app.call("GET", "/api/shop/products/nope", undefined, A())).body).toEqual({ detail: "المنتج غير موجود" });
  });

  it("patch updates fields; delete is manager-only", async () => {
    const p = await addShopProduct({ barcode: "u1" });
    const upd = (await app.call("PATCH", `/api/shop/products/${p.id}`, { stock: 7, price: 55.555, name: " New " }, A())).body;
    expect(upd.quantity).toBe(7);
    expect(upd.sellingPrice).toBe(55.56);
    expect(upd.name).toBe("New");
    expect((await app.call("PUT", `/api/shop/products/${p.id}`, { name: "  " }, A())).status).toBe(400);

    await app.call("POST", "/api/users", { name: "Cash", email: "cash@example.com", password: "cash1234", role: "cashier" }, A());
    const cashier = (await app.call("POST", "/api/auth/login", { username: "cash@example.com", password: "cash1234" })).body.access_token;
    expect((await app.call("DELETE", `/api/shop/products/${p.id}`, undefined, { token: cashier })).status).toBe(403);
    const del = await app.call("DELETE", `/api/shop/products/${p.id}`, undefined, A());
    expect(del.body).toEqual({ success: true, message: "تم حذف الصنف من المحل" });
    expect((await app.call("DELETE", `/api/shop/products/${p.id}`, undefined, A())).status).toBe(404);
  });
});

describe("inventory", () => {
  it("lists stock per location and applies stock-take adjustments", async () => {
    const shop = await addShopProduct({ barcode: "i1", qty: 6 });
    const wh = (await app.call("POST", "/api/products", { name: "Box", barcode: "i2", quantity: 9 }, A())).body;
    const shopStock = (await app.call("GET", "/api/inventory", undefined, A())).body;
    expect(shopStock).toEqual([{ id: shop.id, product_id: shop.id, location_id: "loc-shop-01", quantity: 6 }]);
    const whStock = (await app.call("GET", "/api/inventory?location_id=loc-wh-01", undefined, A())).body;
    expect(whStock).toEqual([{ id: wh.id, product_id: wh.id, location_id: "loc-wh-01", quantity: 9 }]);

    const adj = await app.call("POST", "/api/inventory/adjustments", { barcode: "i1", newQuantity: 4, reason: "جرد" }, A());
    expect(adj.status).toBe(200);
    expect(adj.body).toMatchObject({ status: "COMPLETED", productId: shop.id, location_id: "loc-shop-01", previousQuantity: 6, newQuantity: 4, reason: "جرد" });
    const adjWh = await app.call("POST", "/api/inventory/adjustments", { productId: wh.id, location_id: "loc-wh-01", newQuantity: 1 }, A());
    expect(adjWh.body.previousQuantity).toBe(9);
    expect((await app.call("GET", `/api/products/${wh.id}`, undefined, A())).body.quantity).toBe(1);

    const missing = await app.call("POST", "/api/inventory/adjustments", { barcode: "zzz", newQuantity: 1 }, A());
    expect(missing.status).toBe(404);
    expect(missing.body.error_code).toBe("PRODUCT_NOT_FOUND");
    expect((await app.call("POST", "/api/inventory/adjustments", { barcode: "i1", newQuantity: -1 }, A())).status).toBe(422);
    expect((await app.call("POST", "/api/inventory/adjustments/abc/complete", {}, A())).body).toEqual({ id: "abc", status: "COMPLETED" });
  });

  it("stock changes are written to the sync outbox", async () => {
    await addShopProduct({ barcode: "q1" });
    const rows = app.db.all<any>(`SELECT tableName, action FROM sync_queue WHERE tableName='shop_products'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].action).toBe("INSERT");
  });
});

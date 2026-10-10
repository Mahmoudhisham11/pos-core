import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers";
import { addShopProduct, salePayload } from "./salesHelpers";

type App = ReturnType<typeof makeApp>;
let app: App;
let tok: string;
const A = () => ({ token: tok });
const post = (path: string, body: any, headers?: Record<string, string>) => app.call("POST", path, body, { token: tok, headers });
const get = (path: string) => app.call("GET", path, undefined, A());
const stockOf = async (id: string) => (await get(`/api/shop/products/${id}`)).body.quantity;

beforeEach(async () => {
  app = makeApp();
  tok = await app.login();
});

describe("sales flow", () => {
  it("sale deducts stock and recomputes totals", async () => {
    const p = await addShopProduct(app, tok, { qty: 10, price: 100, cost: 60 });
    const res = await post("/api/sales", salePayload(p, 3, { discount: 30, total: 1 }));
    expect(res.status).toBe(200);
    const sale = res.body;
    expect(sale.subtotal).toBe(300);
    expect(sale.total).toBe(270); // client-sent total is ignored
    expect(sale.totalCost).toBe(180);
    expect(sale.totalProfit).toBe(90);
    expect(sale.paidAmount).toBe(270);
    expect(sale.remainingDue).toBe(0);
    expect(await stockOf(p.id)).toBe(7);
  });

  it("stock changes reach the outbox as deltas (pushed as cloud increments)", async () => {
    const p = await addShopProduct(app, tok, { qty: 10 });
    await post("/api/sales", salePayload(p, 3));
    const q = (await get("/api/sync/queue?limit=100")).body as any[];
    const upd = q.filter((x) => x.tableName === "shop_products" && x.action === "UPDATE").pop();
    expect(upd.payload.quantity).toBe(7);
    expect(upd.payload.__deltas).toMatchObject({ quantity: -3, stock: -3 });
    const ins = q.find((x) => x.tableName === "shop_products" && x.action === "INSERT");
    expect(ins.payload.__deltas).toBeUndefined(); // a new product is written as is
  });

  it("a discount can never take the invoice down to its wholesale cost", async () => {
    const p = await addShopProduct(app, tok, { qty: 10, price: 100, cost: 60 });
    const bad = await post("/api/sales", salePayload(p, 1, { discount: 40 })); // 60 = cost
    expect(bad.status).toBe(400);
    expect(bad.body.error_code).toBe("DISCOUNT_BELOW_COST");
    expect(await stockOf(p.id)).toBe(10);
    expect((await post("/api/sales", salePayload(p, 1, { discount: 39 }))).status).toBe(200); // 61 > 60
  });

  it("insufficient stock is rejected and nothing changes", async () => {
    const p = await addShopProduct(app, tok, { qty: 2 });
    const res = await post("/api/sales", salePayload(p, 5));
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe("INSUFFICIENT_STOCK");
    expect(await stockOf(p.id)).toBe(2);
    expect((await get("/api/sales")).body).toEqual([]);
  });

  it("invalid quantities rejected", async () => {
    const p = await addShopProduct(app, tok, { qty: 5 });
    expect((await post("/api/sales", salePayload(p, -2))).status).toBe(422);
    expect((await post("/api/sales", salePayload(p, 0))).status).toBe(422);
    expect((await post("/api/sales", { items: [] })).status).toBe(422);
    expect(await stockOf(p.id)).toBe(5);
  });

  it("unknown product rejected", async () => {
    const res = await post("/api/sales", { items: [{ name: "ghost", barcode: "zzz", quantity: 1, sellingPrice: 5 }] });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe("PRODUCT_NOT_FOUND");
  });

  it("credit sale with zero paid is not treated as paid", async () => {
    const p = await addShopProduct(app, tok, { qty: 10, price: 100 });
    const cust = (await post("/api/customers", { name: "Mona", phone: "01", type: "جملة" })).body;
    expect(cust.type).toBe("جملة");
    const res = await post("/api/sales", salePayload(p, 2, { paymentMethod: "آجل", paidAmount: 0, customer: { id: cust.id, name: "Mona" } }));
    expect(res.status).toBe(200);
    expect(res.body.paidAmount).toBe(0);
    expect(res.body.remainingDue).toBe(200);

    const c = (await get(`/api/customers/${cust.id}`)).body;
    expect(c.remainingBalance).toBe(200);
    expect(c.balance).toBe(200);
    expect(c.totalPurchases).toBe(200);
    expect(c.transactions.some((t: any) => t.type === "فاتورة مبيعات آجل")).toBe(true);
    const note = c.transactions.find((t: any) => t.type === "فاتورة مبيعات آجل").notes;
    expect(note).toContain("(المتبقي: 200.0 ج.م من إجمالي: 200.0 ج.م)");
  });

  it("credit sale requires customer", async () => {
    const p = await addShopProduct(app, tok, { qty: 10 });
    const res = await post("/api/sales", salePayload(p, 1, { paymentMethod: "آجل", paidAmount: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe("CUSTOMER_REQUIRED");
    expect(await stockOf(p.id)).toBe(10);
  });

  it("idempotency key prevents double sale", async () => {
    const p = await addShopProduct(app, tok, { qty: 10 });
    const h = { "Idempotency-Key": "abc-123" };
    const first = (await post("/api/sales", salePayload(p, 2), h)).body;
    const second = (await post("/api/sales", salePayload(p, 2), h)).body;
    expect(first.id).toBe(second.id);
    expect(await stockOf(p.id)).toBe(8);
    expect((await get("/api/sales")).body).toHaveLength(1);
  });

  it("duplicate invoice numbers get unique numbers", async () => {
    const p = await addShopProduct(app, tok, { qty: 10 });
    const a = (await post("/api/sales", salePayload(p, 1, { invoiceNumber: "INV-1" }))).body;
    const b = (await post("/api/sales", salePayload(p, 1, { invoiceNumber: "INV-1" }))).body;
    expect(a.invoiceNumber).toBe("INV-1");
    expect(b.invoiceNumber).not.toBe("INV-1");
  });

  it("commission rate zero is respected", async () => {
    const emp = (await post("/api/employees", { name: "Zed", commissionRate: 0 })).body;
    expect(emp.commissionRate).toBe(0);
    const p = await addShopProduct(app, tok, { qty: 10 });
    await post("/api/sales", salePayload(p, 1, { sellerEmployee: { id: emp.id, name: "Zed" } }));
    expect((await get("/api/employees/transactions")).body).toEqual([]);
  });

  it("commission recorded", async () => {
    const emp = (await post("/api/employees", { name: "Amr", commissionRate: 0.05 })).body;
    const p = await addShopProduct(app, tok, { qty: 10, price: 100 });
    await post("/api/sales", salePayload(p, 2, { sellerEmployee: { id: emp.id, name: "Amr" } }));
    const txs = (await get("/api/employees/transactions")).body;
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(10);
    expect(txs[0].type).toBe("commission");
  });

  it("partial return restocks and cannot exceed sold", async () => {
    const p = await addShopProduct(app, tok, { qty: 10, price: 100 });
    const sale = (await post("/api/sales", salePayload(p, 3))).body;
    const body = { invoiceId: sale.id, returnedItems: [{ productId: p.id, barcode: "111", name: p.name, quantity: 2 }] };
    const ret = await post("/api/returns", body);
    expect(ret.status).toBe(200);
    expect(ret.body.refundedAmount).toBe(200);
    expect(await stockOf(p.id)).toBe(9); // 10 - 3 + 2

    const updated = (await get(`/api/sales/${sale.id}`)).body;
    expect(updated.total).toBe(100);
    expect(updated.itemsCount).toBe(1);

    // the same two units cannot be returned again (only 1 left on the invoice)
    const again = await post("/api/returns", body);
    expect(again.status).toBe(400);
    expect(again.body.error_code).toBe("RETURN_EXCEEDS_SOLD");
    expect(await stockOf(p.id)).toBe(9);
  });

  it("full return marks invoice and blocks second return", async () => {
    const p = await addShopProduct(app, tok, { qty: 5, price: 50 });
    const sale = (await post("/api/sales", salePayload(p, 2))).body;
    const ret = await post("/api/returns", { invoiceId: sale.id, returnReason: "كامل" });
    expect(ret.status).toBe(200);
    expect(ret.body.refundedAmount).toBe(100);
    expect(await stockOf(p.id)).toBe(5);
    const inv = (await get(`/api/sales/${sale.id}`)).body;
    expect(inv.status).toBe("مرتجعة");
    expect(inv.total).toBe(0);

    const again = await post("/api/returns", { invoiceId: sale.id });
    expect(again.status).toBe(400);
    expect(again.body.error_code).toBe("ALREADY_RETURNED");
  });

  it("return of item not in invoice rejected", async () => {
    const a = await addShopProduct(app, tok, { name: "A", barcode: "a1" });
    await addShopProduct(app, tok, { name: "B", barcode: "b1" });
    const b = (await get("/api/shop/products")).body.find((x: any) => x.barcode === "b1");
    const sale = (await post("/api/sales", salePayload(a, 1))).body;
    const res = await post("/api/returns", { invoiceId: sale.id, returnedItems: [{ productId: b.id, barcode: "b1", name: "B", quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe("ITEM_NOT_IN_INVOICE");
  });

  it("credit sale return reduces customer debt", async () => {
    const p = await addShopProduct(app, tok, { qty: 10, price: 100 });
    const cust = (await post("/api/customers", { name: "Hoda" })).body;
    const sale = (await post("/api/sales", salePayload(p, 3, { paymentMethod: "آجل", paidAmount: 0, customer: { id: cust.id } }))).body;
    await post("/api/returns", { invoiceId: sale.id, returnedItems: [{ productId: p.id, barcode: "111", name: p.name, quantity: 1 }] });
    const c = (await get(`/api/customers/${cust.id}`)).body;
    expect(c.remainingBalance).toBe(200);
    expect(c.totalPurchases).toBe(200);
  });

  it("delete open sale restocks", async () => {
    const p = await addShopProduct(app, tok, { qty: 4 });
    const sale = (await post("/api/sales", salePayload(p, 3))).body;
    expect(await stockOf(p.id)).toBe(1);
    expect((await app.call("DELETE", `/api/sales/${sale.id}`, undefined, A())).status).toBe(200);
    expect(await stockOf(p.id)).toBe(4);
  });

  it("rejected sale rolls back completely (no stock change, no outbox rows)", async () => {
    const p = await addShopProduct(app, tok, { qty: 3 });
    const count = () => (app.db.get<{ c: number }>(`SELECT COUNT(*) c FROM sync_queue`)!).c;
    const before = count();
    expect((await post("/api/sales", salePayload(p, 99))).status).toBe(400);
    expect(count()).toBe(before);
  });

  it("legacy quirk: GET /sales/returns is shadowed by /sales/{id}; /returns works", async () => {
    expect((await get("/api/sales/returns")).status).toBe(404);
    expect((await get("/api/returns")).status).toBe(200);
  });
});

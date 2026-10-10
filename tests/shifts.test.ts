import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers";
import { addShopProduct, salePayload } from "./salesHelpers";
import { performAutoCloseShift } from "../src/domain/shifts";

type App = ReturnType<typeof makeApp>;
let app: App;
let tok: string;
const A = () => ({ token: tok });
const post = (path: string, body: any) => app.call("POST", path, body, A());
const get = (path: string) => app.call("GET", path, undefined, A());

beforeEach(async () => {
  app = makeApp();
  tok = await app.login();
});

describe("shifts", () => {
  it("closing shift links invoices instead of deleting", async () => {
    const p = await addShopProduct(app, tok, { qty: 10, price: 100, cost: 60 });
    for (let i = 0; i < 2; i++) await post("/api/sales", salePayload(p, 1));

    const res = await post("/api/reports", { totalSales: 1, clearSales: true });
    expect(res.status).toBe(200);
    const report = res.body;
    expect(report.totalSales).toBe(200); // computed server-side, client number ignored
    expect(report.invoicesCount).toBe(2);
    expect(report.totalProfit).toBe(80);

    expect((await get("/api/sales")).body).toEqual([]); // open shift is empty again
    const closed = (await get("/api/sales?includeClosed=true")).body;
    expect(closed).toHaveLength(2);
    expect(closed.every((s: any) => s.shiftReportId === report.id)).toBe(true);

    // nothing was queued as a cloud DELETE for the invoices
    const q = (await get("/api/sync/queue?limit=500")).body;
    expect(q.filter((x: any) => x.tableName === "sales" && x.action === "DELETE")).toEqual([]);
    // closing again with nothing open is refused
    expect((await post("/api/reports", {})).status).toBe(400);
  });

  it("closed invoice cannot be deleted but can be returned", async () => {
    const p = await addShopProduct(app, tok, { qty: 5, price: 10 });
    const sale = (await post("/api/sales", salePayload(p, 2))).body;
    await post("/api/reports", {});
    expect((await app.call("DELETE", `/api/sales/${sale.id}`, undefined, A())).status).toBe(409);
    expect((await post("/api/returns", { invoiceId: sale.id })).status).toBe(200);
  });

  it("stale shift is closed by scheduler catch-up", async () => {
    const p = await addShopProduct(app, tok, { qty: 5, price: 10 });
    const sale = (await post("/api/sales", salePayload(p, 1))).body;
    expect(performAutoCloseShift(app.db, new Date())).toEqual([]); // today's invoices stay open

    app.db.run(`UPDATE sales SET createdAt='2020-01-05T10:00:00+00:00', date='2020-01-05' WHERE id=?`, [sale.id]);
    const reports = performAutoCloseShift(app.db, new Date());
    expect(reports).toHaveLength(1);
    expect(reports[0].date).toBe("2020-01-05");
    expect((await get("/api/sales")).body).toEqual([]);
  });

  it("expected drawer cash counts every cash movement of the shift", async () => {
    const p = await addShopProduct(app, tok, { qty: 50, price: 10, cost: 4 });
    const cust = (await post("/api/customers", { name: "Client", phone: "010" })).body;
    // cash sale 100, card sale 50 (not in the drawer), credit sale 80 with 30 paid now
    const cashSale = (await post("/api/sales", salePayload(p, 10, { paymentMethod: "نقدي" }))).body;
    await post("/api/sales", salePayload(p, 5, { paymentMethod: "فيزا" }));
    await post("/api/sales", salePayload(p, 8, { paymentMethod: "آجل", paidAmount: 30, customer: { id: cust.id, name: "Client" } }));
    // 2 pieces of the cash sale come back (-20), the client pays 10 of the debt (+10)
    expect((await post("/api/returns", { invoiceId: cashSale.id, returnedItems: [{ productId: p.id, barcode: p.barcode, name: p.name, quantity: 2 }] })).status).toBe(200);
    expect((await post(`/api/customers/${cust.id}/payments`, { amount: 10, method: "نقدي" })).status).toBe(200);
    // an expense paid in cash (-15) and a withdrawal from the drawer (-5)
    await post("/api/expenses", { itemId: "rent", itemName: "Rent", month: new Date().toISOString().slice(0, 7), amount: 15, transactions: [{ id: "e1", amount: 15, method: "نقدي", date: new Date().toISOString() }] });
    await post("/api/treasury/transactions", { type: "سحب", amount: 5, fromMethod: "نقدي" });

    const now = (await get("/api/shifts/current-cash")).body;
    expect(now.flow.cash.byKind).toMatchObject({ sales: 130, refunds: 20, collections: 10, expenses: 15, treasuryOut: 5 });
    expect(now.flow.visa.byKind.sales).toBe(50);
    expect(now.expectedCash).toBe(100); // 100 + 30 - 20 + 10 - 15 - 5

    const report = (await post("/api/reports", { openingCash: 200, closingCashActual: 290 })).body;
    expect(report.closingCashExpected).toBe(300); // opening float 200 + 100
    expect(report.closingCashActual).toBe(290); // 10 short, visible in the report
    expect(report.totalExpenses).toBe(15);
  });

  it("a return after the shift was closed also corrects that day's report", async () => {
    const p = await addShopProduct(app, tok, { qty: 10, price: 100, cost: 60 });
    const sale = (await post("/api/sales", salePayload(p, 3))).body;
    const report = (await post("/api/reports", {})).body;
    expect(report.totalSales).toBe(300);
    expect(report.totalProfit).toBe(120);
    const ret = await post("/api/returns", { invoiceId: sale.id, returnedItems: [{ productId: p.id, barcode: p.barcode, name: p.name, quantity: 1 }] });
    expect(ret.status).toBe(200);
    const after = (await get(`/api/reports/${report.id}`)).body;
    expect(after.totalSales).toBe(200);
    expect(after.totalProfit).toBe(80);
    expect(after.totalItemsSold).toBe(2);
  });

  it("auto-close makes ONE report per day even when another device already closed that day", async () => {
    const p = await addShopProduct(app, tok, { qty: 5, price: 10, cost: 4 });
    const s1 = (await post("/api/sales", salePayload(p, 1))).body;
    app.db.run(`UPDATE sales SET createdAt='2020-01-05T10:00:00+00:00', date='2020-01-05' WHERE id=?`, [s1.id]);
    const first = performAutoCloseShift(app.db, new Date());
    expect(first[0].id).toBe("auto-2020-01-05");

    // a sale of the same day arrives later from another device (still open here)
    const s2 = (await post("/api/sales", salePayload(p, 2))).body;
    app.db.run(`UPDATE sales SET createdAt='2020-01-05T15:00:00+00:00', date='2020-01-05' WHERE id=?`, [s2.id]);
    const second = performAutoCloseShift(app.db, new Date());
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("auto-2020-01-05");
    expect(second[0].invoicesCount).toBe(2);
    expect(second[0].totalSales).toBe(30);
    expect(second[0].totalProfit).toBe(18);
    expect(app.db.get<any>(`SELECT COUNT(*) AS n FROM shift_reports`).n).toBe(1);
  });

  it("auto-close trigger endpoint, report CRUD and manual archive", async () => {
    const none = await post("/api/shifts/auto-close-trigger", {});
    expect(none.body.message).toBe("لا توجد فواتير من أيام سابقة تحتاج للتقفيل");

    const archived = (await post("/api/shifts/reports", { clearSales: false, totalSales: 50, reportNumber: "R-1", invoices: [{ a: 1 }] })).body;
    expect(archived.totalSales).toBe(50);
    expect(archived.invoicesCount).toBe(1);
    expect((await get("/api/reports/R-1")).body.id).toBe(archived.id);
    const upd = await app.call("PUT", `/api/reports/${archived.id}`, { totalSales: 75.555, notes: "x" }, A());
    expect(upd.body.totalSales).toBe(75.56);
    expect((await get("/api/shifts")).body).toHaveLength(1);
    expect((await app.call("DELETE", `/api/reports/${archived.id}`, undefined, A())).status).toBe(200);
    expect((await get("/api/reports/R-1")).status).toBe(404);
  });
});

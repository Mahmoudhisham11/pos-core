import { beforeEach, describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./helpers";

let app: TestApp;
let tok: string;
const A = () => ({ token: tok });

beforeEach(async () => {
  app = makeApp();
  tok = await app.login();
});

describe("customers", () => {
  it("customer payment is atomic and logs the ledger", async () => {
    const cust = (await app.call("POST", "/api/customers", { name: "Dina", balance: 500 }, A())).body;
    const res = await app.call("POST", `/api/customers/${cust.id}/payments`, { amount: 200, notes: "دفعة" }, A());
    expect(res.status).toBe(200);
    expect(res.body.newBalance).toBe(300);
    const c = (await app.call("GET", `/api/customers/${cust.id}`, undefined, A())).body;
    expect(c.balance).toBe(300);
    expect(c.totalPaid).toBe(200);
    expect(c.transactions.map((t: any) => t.type)).toEqual(["رصيد افتتاحي", "سداد دفعة حساب"]);
    expect((await app.call("POST", `/api/customers/${cust.id}/payments`, { amount: 0 }, A())).status).toBe(422);
  });

  it("crud, search, ledger and manager-only delete", async () => {
    const a = (await app.call("POST", "/api/customers", { name: "Mona", phone: "01" }, A())).body;
    await app.call("POST", "/api/customers", { name: "Zaki", phone: "02" }, A());
    expect(a.type).toBe("قطاعي");
    expect((await app.call("POST", "/api/customers", { name: "" }, A())).status).toBe(422);
    const found = (await app.call("GET", "/api/customers?search=mon", undefined, A())).body;
    expect(found.map((c: any) => c.name)).toEqual(["Mona"]);
    expect((await app.call("GET", "/api/customers?limit=0", undefined, A())).status).toBe(422);
    const upd = await app.call("PUT", `/api/customers/${a.id}`, { name: "Mona2", balance: 40 }, A());
    expect(upd.body.name).toBe("Mona2");
    expect(upd.body.remainingBalance).toBe(40);
    expect((await app.call("PATCH", `/api/customers/${a.id}`, { name: "  " }, A())).status).toBe(400);
    expect((await app.call("GET", `/api/customers/${a.id}/ledger`, undefined, A())).body).toEqual([]);
    expect((await app.call("GET", "/api/customers/nope", undefined, A())).body).toEqual({ detail: "العميل غير موجود" });
    expect((await app.call("DELETE", `/api/customers/${a.id}`, undefined, A())).body.success).toBe(true);
    expect((await app.call("GET", `/api/customers/${a.id}`, undefined, A())).status).toBe(404);
  });
});

describe("suppliers", () => {
  it("charge and payment move balance and totals", async () => {
    const s = (await app.call("POST", "/api/suppliers", { name: "Acme", balance: 100 }, A())).body;
    let r = await app.call("POST", `/api/suppliers/${s.id}/payments`, { amount: 30, type: "charge" }, A());
    expect(r.body.newBalance).toBe(130);
    r = await app.call("POST", `/api/suppliers/${s.id}/payments`, { amount: 50 }, A());
    expect(r.body.newBalance).toBe(80);
    expect(r.body.supplier.totalPaid).toBe(50);
    expect(r.body.supplier.totalPurchases).toBe(30);
    expect((await app.call("POST", `/api/suppliers/${s.id}/payments`, { amount: 5, type: "x" }, A())).body.error_code).toBe("VALIDATION_ERROR");
    expect((await app.call("GET", `/api/suppliers/${s.id}/ledger`, undefined, A())).body).toHaveLength(3);
    expect((await app.call("DELETE", `/api/suppliers/${s.id}`, undefined, A())).body.message).toBe("تم حذف المورد");
  });
});

describe("ledger corrections and multi-device merge", () => {
  it("deleting a supplier movement reverses exactly that movement; invoice entries are refused", async () => {
    const s = (await app.call("POST", "/api/suppliers", { name: "Acme" }, A())).body;
    const charge = (await app.call("POST", `/api/suppliers/${s.id}/payments`, { amount: 300, type: "charge" }, A())).body.transaction;
    const pay = (await app.call("POST", `/api/suppliers/${s.id}/payments`, { amount: 100 }, A())).body.transaction;
    let r = await app.call("DELETE", `/api/suppliers/${s.id}/transactions/${pay.id}`, undefined, A());
    expect(r.body.supplier).toMatchObject({ remainingBalance: 300, totalPaid: 0, totalPurchases: 300 });
    r = await app.call("DELETE", `/api/suppliers/${s.id}/transactions/${charge.id}`, undefined, A());
    expect(r.body.supplier).toMatchObject({ remainingBalance: 0, totalPurchases: 0 });
    expect(r.body.supplier.voidedTxIds).toEqual(expect.arrayContaining([pay.id, charge.id]));
    // a purchase invoice entry cannot be deleted from the ledger
    app.db.run(`UPDATE suppliers SET transactions=? WHERE id=?`, [JSON.stringify([{ id: "tx_pur_1", type: "فاتورة مشتريات", amount: 50 }]), s.id]);
    expect((await app.call("DELETE", `/api/suppliers/${s.id}/transactions/tx_pur_1`, undefined, A())).status).toBe(400);
  });

  it("expense payments are added one by one; the amount is always their sum", async () => {
    const add = (amount: number, id?: string) => app.call("POST", "/api/expenses/monthly/transactions", { month: "2026-10", itemId: "rent", itemName: "Rent", amount, id, date: "2026-10-05" }, A());
    await add(100, "e1");
    expect((await add(50, "e2")).body.newAmount).toBe(150);
    const del = await app.call("DELETE", "/api/expenses/monthly/2026-10/rent/transactions/e1", undefined, A());
    expect(del.body.newAmount).toBe(50);
    // a client sending a wrong total next to its list cannot make them disagree
    const saved = (await app.call("POST", "/api/expenses", { month: "2026-10", itemId: "rent", amount: 999, transactions: [{ id: "e2", amount: 50 }] }, A())).body;
    expect(saved.amount).toBe(50);
  });

  it("a cloud copy missing this device's ledger entries is merged, not overwritten, and re-uploaded", async () => {
    const c = (await app.call("POST", "/api/customers", { name: "Client" }, A())).body;
    await app.call("POST", `/api/customers/${c.id}/payments`, { amount: 10 }, A()); // local entry L
    const local = app.db.get<any>(`SELECT transactions FROM customers WHERE id=?`, [c.id]);
    const localTx = JSON.parse(local.transactions)[0];
    app.db.run(`DELETE FROM sync_queue`); // pretend it was pushed already
    // another device's copy: has its own entry R, not L, plus an entry this device deleted earlier (V)
    app.db.run(`UPDATE customers SET voidedTxIds=? WHERE id=?`, [JSON.stringify(["V"]), c.id]);
    const res = await app.call("POST", "/api/sync/apply-batch", { items: [{ collectionName: "nelly_customers", docId: c.id, data: {
      name: "Client", balance: -30, remainingBalance: -30,
      transactions: [{ id: "R", type: "سداد دفعة حساب", amount: 20, date: "2026-10-01T10:00:00Z" }, { id: "V", type: "x", amount: 1 }],
    } }] }, A());
    expect(res.body.appliedCount).toBe(1);
    const row = app.db.get<any>(`SELECT * FROM customers WHERE id=?`, [c.id]);
    const ids = JSON.parse(row.transactions).map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["R", localTx.id]));
    expect(ids).not.toContain("V");
    expect(row.remainingBalance).toBe(-30); // counters come from the cloud (sum of increments)
    // the merged ledger is queued for upload WITHOUT moving any counter
    const q = (await app.call("GET", "/api/sync/queue?limit=10", undefined, A())).body;
    expect(q).toHaveLength(1);
    expect(q[0].payload.__deltas).toMatchObject({ remainingBalance: 0, balance: 0, totalPaid: 0 });
  });
});

describe("treasury", () => {
  it("validation, transfer target and accounts", async () => {
    const post = (b: any) => app.call("POST", "/api/treasury/transactions", b, A());
    expect((await post({ type: "إيداع", amount: 1000, fromMethod: "نقدي" })).status).toBe(200);
    await post({ type: "سحب", amount: 1500, fromMethod: "نقدي" });
    const tr = await post({ type: "تحويل", amount: 200, fromMethod: "نقدي", toMethod: "فيزا" });
    expect(tr.status).toBe(200);
    expect(tr.body.toMethod).toBe("فيزا");

    expect((await post({ type: "تحويل", amount: 5, fromMethod: "نقدي" })).status).toBe(400);
    expect((await post({ type: "???", amount: 5 })).status).toBe(400);
    expect((await post({ type: "إيداع", amount: 0 })).status).toBe(400);

    const listed = (await app.call("GET", "/api/treasury/transactions", undefined, A())).body;
    expect(listed.find((t: any) => t.type === "تحويل").toMethod).toBe("فيزا");

    const accounts = Object.fromEntries(
      (await app.call("GET", "/api/treasury/accounts", undefined, A())).body.map((a: any) => [a.name, a.current_balance]),
    );
    expect(accounts["نقدي"]).toBe(-700); // shortfall is visible, not clamped to 0
    expect(accounts["فيزا"]).toBe(200);
  });

  it("idempotency key replays the stored response", async () => {
    const h = { token: tok, headers: { "Idempotency-Key": "k1" } };
    const a = await app.call("POST", "/api/treasury", { type: "deposit", amount: 10 }, h);
    const b = await app.call("POST", "/api/treasury", { type: "deposit", amount: 10 }, h);
    expect(b.body.id).toBe(a.body.id);
    expect((await app.call("GET", "/api/treasury", undefined, A())).body).toHaveLength(1);
  });
});

describe("employees", () => {
  it("commission rate 0 is kept and validated", async () => {
    const e = (await app.call("POST", "/api/employees", { name: "Zed", commissionRate: 0 }, A())).body;
    expect(e.commissionRate).toBe(0);
    const d = (await app.call("POST", "/api/employees", { name: "Def" }, A())).body;
    expect(d.commissionRate).toBe(0.01);
    expect(d.role).toBe("موظف مبيعات");
    expect((await app.call("POST", "/api/employees", { name: "Bad", commissionRate: 2 }, A())).status).toBe(422);
    expect((await app.call("PUT", `/api/employees/${e.id}`, { commissionRate: 2 }, A())).body.error_code).toBe("VALIDATION_ERROR");
    expect((await app.call("PUT", `/api/employees/${e.id}`, { base_salary: -1 }, A())).status).toBe(400);
    const u = (await app.call("PATCH", `/api/employees/${e.id}`, { baseSalary: 1500.555 }, A())).body;
    expect(u.baseSalary).toBe(1500.56);
    expect(u.base_salary).toBe(1500.56);
  });

  it("transactions and attendance", async () => {
    const e = (await app.call("POST", "/api/employees", { name: "Amr" }, A())).body;
    expect((await app.call("POST", "/api/employees/transactions", { employeeId: "nope", amount: 5 }, A())).body.error_code).toBe("EMPLOYEE_NOT_FOUND");
    expect((await app.call("POST", "/api/employees/transactions", { employeeId: e.id, amount: 0 }, A())).body.error_code).toBe("INVALID_AMOUNT");
    const tx = (await app.call("POST", "/api/employees/transactions", { employeeId: e.id, amount: 50, month: "2026-01" }, A())).body;
    expect(tx.type).toBe("advance");
    const again = (await app.call("POST", "/api/employees/transactions", { id: tx.id, employeeId: e.id, amount: 99 }, A())).body;
    expect(again.amount).toBe(50);
    expect((await app.call("GET", "/api/employees/transactions?month=2026-01", undefined, A())).body).toHaveLength(1);

    const att = (await app.call("POST", "/api/employees/attendance", { employeeId: e.id, date: "2026-01-02" }, A())).body;
    expect(att.status).toBe("attended");
    const up = (await app.call("PUT", `/api/employees/attendance/${att.id}`, { checkOut: "x", durationMinutes: -5 }, A())).body;
    expect(up.durationMinutes).toBe(0);
    expect((await app.call("GET", "/api/employees/attendance?date=2026-01-02", undefined, A())).body).toHaveLength(1);
    expect((await app.call("POST", "/api/employees/attendance", {}, A())).body.message).toBe("معرف الموظف مطلوب");
    expect((await app.call("DELETE", `/api/employees/${e.id}`, undefined, A())).body.message).toBe("تم حذف الموظف");
  });
});

describe("expenses", () => {
  it("items and monthly upsert", async () => {
    const item = (await app.call("POST", "/api/expenses/items", { name: "Rent" }, A())).body;
    expect((await app.call("POST", "/api/expenses/items", { name: " " }, A())).status).toBe(400);
    const r1 = (await app.call("POST", "/api/expenses/monthly", { itemId: item.id, month: "2026-01", amount: 100, transactions: [{ a: 1 }] }, A())).body;
    expect(r1.id).toBe(`2026-01_${item.id}`);
    const r2 = (await app.call("POST", "/api/expenses", { itemId: item.id, monthStr: "2026-01", amount: 150 }, A())).body;
    expect(r2.id).toBe(r1.id);
    expect(r2.amount).toBe(150);
    expect((await app.call("GET", "/api/expenses?month=2026-01", undefined, A())).body).toHaveLength(1);
    expect((await app.call("POST", "/api/expenses", { amount: 1 }, A())).body.error_code).toBe("VALIDATION_ERROR");
    expect((await app.call("POST", "/api/expenses", { itemId: "x", amount: -1 }, A())).body.error_code).toBe("INVALID_AMOUNT");
    await app.call("DELETE", `/api/expenses/items/${item.id}`, undefined, A());
    expect((await app.call("GET", "/api/expenses/monthly", undefined, A())).body).toEqual([]);
    expect((await app.call("PUT", "/api/expenses/items/zzz", {}, A())).status).toBe(404);
  });
});

describe("permissions", () => {
  it("cashier cannot delete customers or write treasury", async () => {
    const cashier = await app.loginCashier(tok);
    expect((await app.call("DELETE", "/api/customers/abc", undefined, { token: cashier })).status).toBe(403);
    expect((await app.call("POST", "/api/treasury", { type: "deposit", amount: 1 }, { token: cashier })).status).toBe(403);
    expect((await app.call("POST", "/api/employees", { name: "x" }, { token: cashier })).status).toBe(403);
    expect((await app.call("GET", "/api/customers")).status).toBe(401);
  });
});

describe("sync outbox", () => {
  it("customer writes enqueue sync rows", async () => {
    const c = (await app.call("POST", "/api/customers", { name: "Q" }, A())).body;
    await app.call("DELETE", `/api/customers/${c.id}`, undefined, A());
    const rows = app.db.all<any>(`SELECT action FROM sync_queue WHERE tableName='customers' AND recordId=?`, [c.id]);
    expect(rows.map((r) => r.action)).toEqual(["INSERT", "DELETE"]);
  });
});

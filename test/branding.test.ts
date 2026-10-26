import { describe, expect, it } from "vitest";
import { setup } from "./helpers";
import { TABLE_COLUMNS } from "../src/db/schema";

describe("brand-neutral core", () => {
  it("uses the app's own names and defaults", async () => {
    const { call, backend } = await setup({ APP_NAME: "Fashion POS", COLLECTION_PREFIX: "fashion_", DEFAULT_BRAND: "", BRANCH_NAME: "فرع وسط البلد" });
    expect((await backend.handle({ method: "GET", path: "/", headers: {} })).body.app).toBe("Fashion POS");
    const info = (await backend.handle({ method: "GET", path: "/app-info", headers: {} })).body;
    expect(info.features.variants).toBe(true);
    expect(info.collections.find((c: any) => c.table === "shift_reports").name).toBe("fashion_reports");
    expect(info.collections.find((c: any) => c.table === "shop_products").counter).toBe(true);
    expect((await call("GET", "/branches")).body[0].name).toBe("فرع وسط البلد");
    const p = (await call("POST", "/shop/products", { name: "شنطة" })).body;
    expect(p.brand).toBe("");
    // cloud docs of another prefix are not this app's
    const r = await call("POST", "/sync/apply-batch", { items: [{ collectionName: "nelly_shop_products", docId: "x", action: "SET", data: { id: "x", name: "y" } }] });
    expect(r.body.appliedCount).toBe(0);
  });

  it("Nelly's settings keep the exact collection names already in Firestore", async () => {
    const { backend } = await setup({ COLLECTION_PREFIX: "nelly_", DEFAULT_BRAND: "Nelly" });
    const names = (await backend.handle({ method: "GET", path: "/app-info", headers: {} })).body.collections.map((c: any) => c.name).sort();
    expect(names).toEqual([
      "nelly_customers", "nelly_employee_attendance", "nelly_employee_transactions", "nelly_employees", "nelly_expense_items",
      "nelly_monthly_expenses", "nelly_products", "nelly_reports", "nelly_returns", "nelly_shop_products",
      "nelly_shop_purchase_returns", "nelly_shop_purchases", "nelly_stock_movements", "nelly_suppliers", "nelly_transfers",
      "nelly_treasury_transactions", "nelly_users", "nelly_sales",
    ].sort());
  });

  it("Nelly's default brand still applies", async () => {
    const { call } = await setup({ COLLECTION_PREFIX: "nelly_", DEFAULT_BRAND: "Nelly" });
    expect((await call("POST", "/shop/products", { name: "روج" })).body.brand).toBe("Nelly");
  });

  it("column metadata matches the real tables (every synced column is applied from the cloud)", async () => {
    const { db } = await setup();
    for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
      const real = db.all<{ name: string }>(`PRAGMA table_info('${table}')`).map((r) => r.name).sort();
      expect(cols.map((c) => c.name).sort(), table).toEqual(real.filter((n) => table !== "users" || n !== "branch" || cols.some((c) => c.name === "branch")));
      for (const c of cols) expect(Array.isArray(c.default), `${table}.${c.name}`).toBe(false);
    }
  });
});

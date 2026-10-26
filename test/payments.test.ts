import { describe, expect, it } from "vitest";
import { setup } from "./helpers";
import { canonicalMethod, cashMethod, channelOf, creditMethod, isCreditMethod } from "../src/core/payments";

const KSA = {
  CURRENCY: "SAR",
  CURRENCY_SYMBOL: "ر.س",
  DEFAULT_CUSTOMER_NAME: "عميل",
  DEFAULT_CUSTOMER_TYPE: "عادي",
  PAYMENT_METHODS: [
    { name: "Cash", channel: "cash" as const, aliases: ["نقدي"] },
    { name: "Mada", channel: "visa" as const },
    { name: "STC Pay", channel: "wallets" as const },
    { name: "Later", channel: "cash" as const, credit: true },
  ],
};

describe("payment methods (default = Nelly's)", () => {
  it("maps methods to channels exactly as before", async () => {
    await setup();
    expect(cashMethod()).toBe("نقدي");
    expect(creditMethod()).toBe("آجل");
    for (const m of ["نقدي", "كاش", "cash", " Cash ", "", null, "آجل", "اجل"]) expect(channelOf(m), String(m)).toBe("cash");
    for (const m of ["فيزا", "visa", "card", "بطاقة بنكية", "فيزا بنك مصر"]) expect(channelOf(m), m).toBe("visa");
    for (const m of ["تحويل", "فودافون كاش", "instapay"]) expect(channelOf(m), m).toBe("wallets");
    expect(isCreditMethod("اجل")).toBe(true);
    expect(isCreditMethod("نقدي")).toBe(false);
    expect(canonicalMethod("cash")).toBe("نقدي");
    expect(canonicalMethod("")).toBe("نقدي");
    expect(canonicalMethod("فودافون كاش")).toBe("فودافون كاش");
  });

  it("a sale without a payment method is a cash sale to the default customer", async () => {
    const { call } = await setup();
    const p = (await call("POST", "/shop/products", { name: "روج", quantity: 5, sellingPrice: 100 })).body;
    const sale = await call("POST", "/sales", { items: [{ productId: p.id, quantity: 1, price: 100 }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(sale.body.paymentMethod).toBe("نقدي");
    expect(sale.body.customerName).toBe("عميل نقدي");
  });
});

describe("payment methods of another app", () => {
  it("uses the app's own methods, currency and defaults", async () => {
    const { call, backend } = await setup(KSA);
    expect(cashMethod()).toBe("Cash");
    expect(channelOf("Mada")).toBe("visa");
    expect(channelOf("نقدي")).toBe("cash");

    const info = (await backend.handle({ method: "GET", path: "/app-info", headers: {} })).body;
    expect(info.currency).toEqual({ code: "SAR", symbol: "ر.س" });
    expect(info.paymentMethods.map((m: any) => m.name)).toEqual(["Cash", "Mada", "STC Pay", "Later"]);
    expect(info.defaults.paymentMethod).toBe("Cash");

    const p = (await call("POST", "/shop/products", { name: "Shirt", quantity: 5, sellingPrice: 100 })).body;
    const sale = (await call("POST", "/sales", { items: [{ productId: p.id, quantity: 1, price: 100 }] })).body;
    expect(sale.paymentMethod).toBe("Cash");
    expect(sale.customerName).toBe("عميل");

    // a "pay later" sale collects nothing unless a down payment is sent
    const cust = (await call("POST", "/customers", { name: "Ali" })).body;
    expect(cust.type).toBe("عادي");
    const credit = (await call("POST", "/sales", {
      items: [{ productId: p.id, quantity: 1, price: 100 }], paymentMethod: "Later", customer: { id: cust.id, name: "Ali" },
    })).body;
    expect(credit.paidAmount).toBe(0);
    expect(credit.remainingDue).toBe(100);

    // cash in the drawer only counts the cash sale
    const cash = (await call("GET", "/shifts/current-cash")).body;
    expect(cash.flow.cash.byKind.sales).toBe(100);

    // treasury accounts: the cash account is the app's cash method, in the app's currency
    await call("POST", "/treasury", { type: "إيداع", amount: 50, fromMethod: "cash" });
    const accounts = (await call("GET", "/treasury/accounts")).body;
    expect(accounts).toEqual([expect.objectContaining({ name: "Cash", account_type: "CASH", currency: "SAR", current_balance: 50 })]);
  });
});

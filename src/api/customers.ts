import { deleteRow, getById, insertRow, uid, updateRow } from "../db/sql";
import { httpError } from "../http/errors";
import { serializeList, serializeRow } from "../http/serialize";
import type { Router } from "../http/router";
import type { Ctx } from "../http/types";
import { utcnowIso } from "../core/timeutil";
import { requireManager } from "../core/auth";
import { Validator, bodyObject, dumps, intQuery, loadsList, money, pyFloat, pyStr } from "./partiesCommon";
import { customerPayment, makeTx } from "./partiesLedger";

const NOT_FOUND = "العميل غير موجود";

const mustGet = (ctx: Ctx) => {
  const c = getById(ctx.db, "customers", ctx.params.customer_id!);
  if (!c) throw httpError(404, NOT_FOUND);
  return c;
};

export function registerCustomers(router: Router): void {
  router.get("/customers", (ctx) => {
    const limit = intQuery(ctx, "limit", 1000, 1, 5000);
    const search = ctx.query.search;
    let sql = `SELECT * FROM customers`;
    const args: unknown[] = [];
    if (search) {
      sql += ` WHERE lower(name) LIKE lower(?) OR lower(phone) LIKE lower(?)`;
      const s = `%${search.trim()}%`;
      args.push(s, s);
    }
    sql += ` ORDER BY name ASC LIMIT ?`;
    args.push(limit);
    return serializeList(ctx.db.all(sql, args));
  });

  router.post("/customers", (ctx) => {
    const body = bodyObject(ctx);
    const v = new Validator(body);
    const name = v.str("name", { required: true, min: 1, max: 150 }) as string;
    const phone = v.str("phone"), address = v.str("address"), type = v.str("type"), notes = v.str("notes");
    const balance = v.num("balance");
    const txsIn = v.dictList("transactions");
    v.done();

    const now = utcnowIso(ctx.now());
    const bal = money(balance || 0);
    let txs = txsIn || [];
    if (bal !== 0 && !txs.length) {
      txs = [makeTx("ctx", "رصيد افتتاحي", Math.abs(bal), 0, bal, "تسجيل رصيد افتتاحي", "رصيد افتتاحي", {}, now)];
    }
    const id = uid();
    insertRow(ctx.db, "customers", {
      id, name: name.trim(), phone: phone || "", address: address || "", type: type || "قطاعي",
      balance: bal, remainingBalance: bal, totalPurchases: 0.0, totalPaid: 0.0,
      transactions: dumps(txs), notes: notes || "", createdAt: now, updatedAt: now,
    });
    return serializeRow(getById(ctx.db, "customers", id));
  });

  router.get("/customers/{customer_id}", (ctx) => serializeRow(mustGet(ctx)));

  router.get("/customers/{customer_id}/ledger", (ctx) => loadsList(mustGet(ctx).transactions));

  // Atomic settlement: balance, totals and ledger line change together.
  router.post("/customers/{customer_id}/payments", (ctx) => {
    const cust = mustGet(ctx);
    const body = bodyObject(ctx);
    const v = new Validator(body);
    const amount = v.num("amount", { required: true, gt: 0 }) as number;
    const notes = v.str("notes"), method = v.str("method");
    v.done();
    const { tx, patch } = customerPayment(cust, amount, notes || "", method || "نقدي", utcnowIso(ctx.now()));
    updateRow(ctx.db, "customers", cust.id, patch);
    const fresh = getById(ctx.db, "customers", cust.id);
    return { success: true, newBalance: fresh!.remainingBalance, transaction: tx, customer: serializeRow(fresh) };
  });

  const update = (ctx: Ctx) => {
    const cust = mustGet(ctx);
    const data = bodyObject(ctx);
    const patch: Record<string, unknown> = {};

    if (data.name != null) {
      const name = pyStr(data.name).trim();
      if (!name) throw httpError(400, "اسم العميل مطلوب");
      patch.name = name;
    }
    if (data.phone != null) patch.phone = pyStr(data.phone);
    if (data.address != null) patch.address = pyStr(data.address);
    if (data.type != null) patch.type = pyStr(data.type);
    if (data.balance != null || data.remainingBalance != null) {
      const b = money(pyFloat(data.balance != null ? data.balance : data.remainingBalance));
      patch.remainingBalance = b;
      patch.balance = b;
    }
    if (data.totalPurchases != null) patch.totalPurchases = money(data.totalPurchases);
    if (data.totalPaid != null) patch.totalPaid = money(data.totalPaid);
    if (data.notes != null) patch.notes = pyStr(data.notes);
    if (data.transactions != null) patch.transactions = Array.isArray(data.transactions) ? dumps(data.transactions) : pyStr(data.transactions);

    patch.updatedAt = utcnowIso(ctx.now());
    updateRow(ctx.db, "customers", cust.id, patch);
    return serializeRow(getById(ctx.db, "customers", cust.id));
  };
  router.put("/customers/{customer_id}", update);
  router.patch("/customers/{customer_id}", update);

  router.delete("/customers/{customer_id}", (ctx) => {
    requireManager(ctx);
    const cust = mustGet(ctx);
    deleteRow(ctx.db, "customers", cust.id);
    return { success: true, message: "تم حذف العميل" };
  });
}

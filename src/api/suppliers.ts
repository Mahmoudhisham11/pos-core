import { deleteRow, getById, insertRow, uid, updateRow } from "../db/sql";
import { httpError } from "../http/errors";
import { serializeList, serializeRow } from "../http/serialize";
import type { Router } from "../http/router";
import type { Ctx } from "../http/types";
import { utcnowIso } from "../core/timeutil";
import { requireManager } from "../core/auth";
import { cashMethod } from "../core/payments";
import { Validator, bodyObject, dumps, intQuery, loadsIds, loadsList, money, pyStr } from "./partiesCommon";
import { makeTx, supplierMovement } from "./partiesLedger";

const NOT_FOUND = "المورد غير موجود";

const mustGet = (ctx: Ctx) => {
  const s = getById(ctx.db, "suppliers", ctx.params.supplier_id!);
  if (!s) throw httpError(404, NOT_FOUND);
  return s;
};

export function registerSuppliers(router: Router): void {
  router.get("/suppliers", (ctx) => {
    const limit = intQuery(ctx, "limit", 1000, 1, 5000);
    const search = ctx.query.search;
    let sql = `SELECT * FROM suppliers`;
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

  router.post("/suppliers", (ctx) => {
    const body = bodyObject(ctx);
    const v = new Validator(body);
    const name = v.str("name", { required: true, min: 1, max: 150 }) as string;
    const phone = v.str("phone"), company = v.str("company"), address = v.str("address"), notes = v.str("notes");
    const balance = v.num("balance");
    const txsIn = v.dictList("transactions");
    v.done();

    const now = utcnowIso(ctx.now());
    const bal = money(balance || 0);
    let txs = txsIn || [];
    if (bal !== 0 && !txs.length) {
      txs = [makeTx("tx", "رصيد افتتاحي", Math.abs(bal), 0, bal, "تسجيل رصيد افتتاحي", "رصيد افتتاحي", {}, now)];
    }
    const id = uid();
    insertRow(ctx.db, "suppliers", {
      id, name: name.trim(), phone: phone || "", company: company || "", address: address || "",
      balance: bal, totalPurchases: 0.0, totalPaid: 0.0, remainingBalance: bal,
      transactions: dumps(txs), notes: notes || "", createdAt: now, updatedAt: now,
    });
    return serializeRow(getById(ctx.db, "suppliers", id));
  });

  router.get("/suppliers/{supplier_id}", (ctx) => serializeRow(mustGet(ctx)));

  router.get("/suppliers/{supplier_id}/ledger", (ctx) => loadsList(mustGet(ctx).transactions));

  router.post("/suppliers/{supplier_id}/payments", (ctx) => {
    const supp = mustGet(ctx);
    const body = bodyObject(ctx);
    const v = new Validator(body);
    const amount = v.num("amount", { required: true, gt: 0 }) as number;
    const notes = v.str("notes"), method = v.str("method"), type = v.str("type"); // "payment" (we pay) | "charge" (we owe more)
    v.done();
    const { tx, patch } = supplierMovement(supp, amount, type || "payment", notes || "", method || cashMethod(), utcnowIso(ctx.now()));
    updateRow(ctx.db, "suppliers", supp.id, patch);
    const fresh = getById(ctx.db, "suppliers", supp.id);
    return { success: true, newBalance: fresh!.remainingBalance, transaction: tx, supplier: serializeRow(fresh) };
  });

  const update = (ctx: Ctx) => {
    const supp = mustGet(ctx);
    const data = bodyObject(ctx);
    const patch: Record<string, unknown> = {};

    if (data.name != null) {
      const name = pyStr(data.name).trim();
      if (!name) throw httpError(400, "اسم المورد مطلوب");
      patch.name = name;
    }
    for (const f of ["phone", "address", "notes", "company"]) if (data[f] != null) patch[f] = pyStr(data[f]);
    if (data.balance != null || data.remainingBalance != null) {
      const b = money(data.balance != null ? data.balance : data.remainingBalance);
      patch.balance = b;
      patch.remainingBalance = b;
    }
    if (data.totalPurchases != null) patch.totalPurchases = money(data.totalPurchases);
    if (data.totalPaid != null) patch.totalPaid = money(data.totalPaid);
    if (data.transactions != null) patch.transactions = Array.isArray(data.transactions) ? dumps(data.transactions) : pyStr(data.transactions);

    patch.updatedAt = utcnowIso(ctx.now());
    updateRow(ctx.db, "suppliers", supp.id, patch);
    return serializeRow(getById(ctx.db, "suppliers", supp.id));
  };
  router.put("/suppliers/{supplier_id}", update);
  router.patch("/suppliers/{supplier_id}", update);

  /**
   * Deletes a manual movement and reverses exactly what it did. Purchase invoices / purchase returns are not deleted
   * here: they also moved stock, and are corrected with a purchase return instead.
   */
  router.delete("/suppliers/{supplier_id}/transactions/{tx_id}", (ctx) => {
    requireManager(ctx);
    const supp: any = mustGet(ctx);
    const txs = loadsList(supp.transactions);
    const tx = txs.find((t: any) => String(t.id) === ctx.params.tx_id);
    if (!tx) throw httpError(404, "الحركة المالية غير موجودة");
    const type = String(tx.type || "");
    const amount = money(Math.abs(Number(tx.amount) || 0));
    const bal = money(supp.remainingBalance ?? supp.balance);
    const patch: Record<string, unknown> = {};
    if (type === "سداد دفعة" || type === "payment") {
      patch.remainingBalance = money(bal + amount);
      patch.totalPaid = money(Math.max(0, (supp.totalPaid || 0) - amount));
    } else if (type === "إضافة مستحقات / فاتورة بضاعة" || type === "تعديل رصيد / إضافة مستحقات" || type === "charge") {
      patch.remainingBalance = money(bal - amount);
      patch.totalPurchases = money(Math.max(0, (supp.totalPurchases || 0) - amount));
    } else if (type === "رصيد افتتاحي" || type === "تعديل رصيد يدوي") {
      patch.remainingBalance = money(bal - ((Number(tx.newBalance) || 0) - (Number(tx.previousBalance) || 0)));
    } else {
      throw httpError(400, "الحركة دي جزء من فاتورة أو مرتجع مشتريات ومينفعش تتحذف من هنا. استخدم مرتجع المشتريات.");
    }
    patch.balance = patch.remainingBalance;
    patch.transactions = dumps(txs.filter((t: any) => String(t.id) !== String(tx.id)));
    patch.voidedTxIds = dumps([...new Set([...loadsIds(supp.voidedTxIds), String(tx.id)])]);
    patch.updatedAt = utcnowIso(ctx.now());
    updateRow(ctx.db, "suppliers", supp.id, patch);
    const fresh = getById(ctx.db, "suppliers", supp.id);
    return { success: true, newBalance: fresh!.remainingBalance, supplier: serializeRow(fresh) };
  });

  router.delete("/suppliers/{supplier_id}", (ctx) => {
    requireManager(ctx);
    const supp = mustGet(ctx);
    deleteRow(ctx.db, "suppliers", supp.id);
    return { success: true, message: "تم حذف المورد" };
  });
}

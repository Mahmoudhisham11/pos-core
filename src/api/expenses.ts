import { deleteRow, getById, insertRow, uid, updateRow } from "../db/sql";
import { badRequest, httpError } from "../http/errors";
import { serializeList, serializeRow } from "../http/serialize";
import type { Router } from "../http/router";
import { utcnowIso } from "../core/timeutil";
import { requireManager } from "../core/auth";
import { cashMethod } from "../core/payments";
import { bodyObject, dumps, loadsIds, loadsList, money, pyStr } from "./partiesCommon";

export function registerExpenses(router: Router): void {
  // ---- Expense master items
  router.get("/expenses/items", (ctx) => serializeList(ctx.db.all(`SELECT * FROM expense_items ORDER BY name ASC`)));

  router.post("/expenses/items", (ctx) => {
    const data = bodyObject(ctx);
    const name = pyStr(data.name || "").trim();
    if (!name) throw httpError(400, "اسم البند مطلوب");
    const id = uid();
    insertRow(ctx.db, "expense_items", { id, name, notes: data.notes ? pyStr(data.notes) : "", createdAt: utcnowIso(ctx.now()) });
    return serializeRow(getById(ctx.db, "expense_items", id));
  });

  router.put("/expenses/items/{item_id}", (ctx) => {
    const item = getById(ctx.db, "expense_items", ctx.params.item_id!);
    if (!item) throw httpError(404, "البند غير موجود");
    const data = bodyObject(ctx);
    const patch: Record<string, unknown> = {};
    if (data.name != null) {
      const name = pyStr(data.name).trim();
      if (!name) throw httpError(400, "اسم البند مطلوب");
      patch.name = name;
    }
    if (data.notes != null) patch.notes = pyStr(data.notes).trim();
    updateRow(ctx.db, "expense_items", item.id, patch);
    return serializeRow(getById(ctx.db, "expense_items", item.id));
  });

  router.delete("/expenses/items/{item_id}", (ctx) => {
    requireManager(ctx);
    const item = getById(ctx.db, "expense_items", ctx.params.item_id!);
    if (item) {
      // one delete per record so each removal is queued for sync
      for (const rec of ctx.db.all<any>(`SELECT id FROM monthly_expenses WHERE itemId=?`, [item.id])) deleteRow(ctx.db, "monthly_expenses", rec.id);
      deleteRow(ctx.db, "expense_items", item.id);
    }
    return { success: true, message: "تم حذف بند المصروف" };
  });

  // ---- Monthly expenses
  const list = (ctx: import("../http/types").Ctx) => {
    const m = ctx.query.month || ctx.query.monthStr;
    if (m) return serializeList(ctx.db.all(`SELECT * FROM monthly_expenses WHERE month=? OR monthStr=?`, [m, m]));
    return serializeList(ctx.db.all(`SELECT * FROM monthly_expenses`));
  };
  router.get("/expenses/monthly", list);
  router.get("/expenses", list);

  const save = (ctx: import("../http/types").Ctx) => {
    const data = bodyObject(ctx);
    const now = utcnowIso(ctx.now());
    const month = data.month || data.monthStr || now.slice(0, 7);
    const itemId = data.itemId || data.item_id;
    if (!itemId) throw badRequest("معرف بند المصروف مطلوب", "VALIDATION_ERROR");
    const itemName = data.itemName || data.item_name || "بند مصروف";
    const txs = data.transactions || data.expenses || [];
    // the amount is always the sum of the payments (a client-side total could disagree with its own list)
    const amount = Array.isArray(txs) && txs.length ? money(txs.reduce((t: number, x: any) => t + (Number(x?.amount) || 0), 0)) : money(data.amount || 0.0);
    if (amount < 0) throw badRequest("قيمة المصروف لا يمكن أن تكون سالبة", "INVALID_AMOUNT");
    const txsJson = Array.isArray(txs) ? dumps(txs) : pyStr(txs);

    const existing = ctx.db.get<any>(
      `SELECT * FROM monthly_expenses WHERE itemId=? AND (month=? OR monthStr=?) LIMIT 1`, [itemId, month, month],
    );
    let id: string;
    if (existing) {
      id = existing.id;
      updateRow(ctx.db, "monthly_expenses", id, { amount, itemName, transactions: txsJson, expenses: txsJson, updatedAt: now });
    } else {
      id = `${month}_${itemId}`;
      insertRow(ctx.db, "monthly_expenses", {
        id, month, monthStr: month, itemId, itemName, amount, transactions: txsJson, expenses: txsJson, createdAt: now, updatedAt: now,
      });
    }
    return serializeRow(getById(ctx.db, "monthly_expenses", id));
  };
  // ---- One payment at a time (atomic: never rewrites the record's other payments)
  router.post("/expenses/monthly/transactions", (ctx) => {
    const data = bodyObject(ctx);
    const now = utcnowIso(ctx.now());
    const month = String(data.month || "").slice(0, 7);
    const itemId = data.itemId || data.item_id;
    if (!/^\d{4}-\d{2}$/.test(month) || !itemId) throw badRequest("الشهر وبند المصروف مطلوبين", "VALIDATION_ERROR");
    const amount = money(data.amount);
    if (!(amount > 0)) throw badRequest("المبلغ يجب أن يكون أكبر من صفر", "INVALID_AMOUNT");
    const tx = {
      id: data.id || `tx_${uid().slice(0, 12)}`,
      amount,
      date: String(data.date || now.slice(0, 10)).slice(0, 10),
      notes: pyStr(data.notes || "").trim() || "إضافة مصروف",
      method: data.method || cashMethod(),
      createdAt: now,
    };
    const existing = ctx.db.get<any>(`SELECT * FROM monthly_expenses WHERE itemId=? AND (month=? OR monthStr=?) LIMIT 1`, [itemId, month, month]);
    const txs = [...(existing ? loadsList(existing.transactions ?? existing.expenses) : []), tx];
    const total = money(txs.reduce((t: number, x: any) => t + (Number(x?.amount) || 0), 0));
    const itemName = data.itemName || existing?.itemName || "بند مصروف";
    if (existing) {
      updateRow(ctx.db, "monthly_expenses", existing.id, { amount: total, itemName, transactions: dumps(txs), expenses: dumps(txs), updatedAt: now });
    } else {
      insertRow(ctx.db, "monthly_expenses", {
        id: `${month}_${itemId}`, month, monthStr: month, itemId, itemName, amount: total,
        transactions: dumps(txs), expenses: dumps(txs), createdAt: now, updatedAt: now,
      });
    }
    return { success: true, newAmount: total, transaction: tx };
  });

  router.delete("/expenses/monthly/{month}/{item_id}/transactions/{tx_id}", (ctx) => {
    const { month, item_id: itemId, tx_id: txId } = ctx.params as Record<string, string>;
    const existing = ctx.db.get<any>(`SELECT * FROM monthly_expenses WHERE itemId=? AND (month=? OR monthStr=?) LIMIT 1`, [itemId, month, month]);
    if (!existing) throw httpError(404, "المصروف غير موجود");
    const txs = loadsList(existing.transactions ?? existing.expenses);
    if (!txs.some((t: any) => String(t.id) === txId)) throw httpError(404, "الحركة غير موجودة");
    const left = txs.filter((t: any) => String(t.id) !== txId);
    const total = money(left.reduce((t: number, x: any) => t + (Number(x?.amount) || 0), 0));
    updateRow(ctx.db, "monthly_expenses", existing.id, {
      amount: total, transactions: dumps(left), expenses: dumps(left),
      voidedTxIds: dumps([...new Set([...loadsIds(existing.voidedTxIds), txId])]),
      updatedAt: utcnowIso(ctx.now()),
    });
    return { success: true, newAmount: total };
  });

  router.post("/expenses/monthly", save);
  router.post("/expenses", save);
}

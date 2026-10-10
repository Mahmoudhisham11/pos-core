import { deleteRow, getById, insertRow, uid } from "../db/sql";
import { badRequest } from "../http/errors";
import { serializeRow } from "../http/serialize";
import type { Router } from "../http/router";
import { utcnowIso } from "../core/timeutil";
import { requireManager } from "../core/auth";
import * as idempotency from "../core/idempotency";
import { bodyObject, getKey, intQuery, jsonField, money } from "./partiesCommon";

const DEPOSIT_TYPES = new Set(["إيداع", "deposit", "in"]);
const WITHDRAW_TYPES = new Set(["سحب", "withdraw", "withdrawal", "out"]);
const TRANSFER_TYPES = new Set(["تحويل", "transfer"]);
const KNOWN_TYPES = new Set([...DEPOSIT_TYPES, ...WITHDRAW_TYPES, ...TRANSFER_TYPES]);
const CASH_ALIASES: Record<string, string> = { "كاش": "نقدي", cash: "نقدي" };

function method(value: unknown): string {
  const clean = (value ? String(value) : "نقدي").trim() || "نقدي";
  return Object.prototype.hasOwnProperty.call(CASH_ALIASES, clean.toLowerCase()) ? CASH_ALIASES[clean.toLowerCase()]! : clean;
}

function present(tx: Record<string, any>): Record<string, any> {
  const row = serializeRow(tx);
  if (TRANSFER_TYPES.has(tx.type)) row.toMethod = tx.destination || null; // transfers keep their target account in `destination`
  return row;
}

export function registerTreasury(router: Router): void {
  const list = (ctx: import("../http/types").Ctx) => {
    const limit = intQuery(ctx, "limit", 500, 1, 5000);
    return ctx.db.all<any>(`SELECT * FROM treasury_transactions ORDER BY date DESC, createdAt DESC LIMIT ?`, [limit]).map(present);
  };
  router.get("/treasury/transactions", list);
  router.get("/treasury", list);

  const create = (ctx: import("../http/types").Ctx) => {
    requireManager(ctx);
    const data = bodyObject(ctx);
    const stored = idempotency.lookup(ctx);
    if (stored !== undefined) return stored;

    const now = utcnowIso(ctx.now());
    const txType = String(data.type || "إيداع").trim();
    if (!KNOWN_TYPES.has(txType)) throw badRequest(`نوع الحركة غير معروف: ${txType}`, "INVALID_TYPE");
    const amount = money(data.amount || 0.0);
    if (amount <= 0) throw badRequest("المبلغ يجب أن يكون أكبر من صفر", "INVALID_AMOUNT");
    const toMethod = data.toMethod;
    const isTransfer = TRANSFER_TYPES.has(txType);
    if (isTransfer) {
      if (!toMethod) throw badRequest("وجهة التحويل مطلوبة", "VALIDATION_ERROR");
      if (method(toMethod) === method(data.fromMethod)) throw badRequest("لا يمكن التحويل لنفس الحساب", "VALIDATION_ERROR");
    }

    const dateVal: string = data.dateStr || data.date || now.slice(0, 10);
    const id = uid();
    insertRow(ctx.db, "treasury_transactions", {
      id,
      type: txType,
      amount,
      category: getKey(data, "category", "حركة خزنة"),
      description: data.description || data.notes || "",
      fromMethod: method(data.fromMethod),
      source: getKey(data, "source", ""),
      destination: data.destination || (isTransfer ? method(toMethod) : ""),
      dateStr: dateVal.slice(0, 10),
      date: dateVal,
      notes: getKey(data, "notes", ""),
      createdBy: jsonField(data.createdBy),
      createdAt: now,
      updatedAt: now,
    });
    return idempotency.recordResult(ctx, present(getById(ctx.db, "treasury_transactions", id)!));
  };
  router.post("/treasury/transactions", create);
  router.post("/treasury", create);

  router.delete("/treasury/transactions/{tx_id}", (ctx) => {
    requireManager(ctx);
    const tx = getById(ctx.db, "treasury_transactions", ctx.params.tx_id!);
    if (tx) deleteRow(ctx.db, "treasury_transactions", tx.id);
    return { success: true, message: "تم حذف حركة الخزينة" };
  });

  // Balances per payment method derived from the manual treasury ledger (negative balances are shown as-is).
  router.get("/treasury/accounts", (ctx) => {
    const balances = new Map<string, number>([["نقدي", 0]]);
    const add = (k: string, d: number) => balances.set(k, (balances.get(k) ?? 0) + d);
    for (const t of ctx.db.all<any>(`SELECT * FROM treasury_transactions`)) {
      const m = method(t.fromMethod);
      const amt = t.amount || 0;
      if (DEPOSIT_TYPES.has(t.type)) add(m, amt);
      else if (WITHDRAW_TYPES.has(t.type)) add(m, -amt);
      else if (TRANSFER_TYPES.has(t.type)) {
        add(m, -amt);
        if (t.destination) add(method(t.destination), amt);
      }
    }
    return [...balances.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bal]) => ({
      id: `acc-${name}`,
      name,
      account_type: name === "نقدي" ? "CASH" : "OTHER",
      currency: "EGP",
      current_balance: money(bal),
      is_active: true,
    }));
  });
}

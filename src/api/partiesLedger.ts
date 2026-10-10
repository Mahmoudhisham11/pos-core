// Customer / supplier running-account ledger (port of the parts of domain/ledger.py the parties endpoints use).
// Pure helpers: they return the column patch to write, the caller persists it in its own transaction.
import { uid } from "../db/sql";
import { badRequest } from "../http/errors";
import { dumps, loadsList, money } from "./partiesCommon";

export function makeTx(
  prefix: string, txType: string, amount: number, previous: number, newBalance: number, notes: string, method: string,
  extra: Record<string, unknown> = {}, nowIso: string,
): Record<string, any> {
  return {
    id: `${prefix}_${uid().slice(0, 12)}`,
    date: nowIso,
    type: txType,
    amount: money(amount),
    previousBalance: money(previous),
    newBalance: money(newBalance),
    notes,
    method,
    ...extra,
  };
}

const appended = (entity: Record<string, any>, tx: Record<string, any>) => dumps([...loadsList(entity.transactions), tx]);

export function customerPayment(cust: Record<string, any>, amountIn: unknown, notes: string, method: string, nowIso: string) {
  const amount = money(amountIn);
  if (amount <= 0) throw badRequest("المبلغ يجب أن يكون أكبر من صفر", "INVALID_AMOUNT");
  const prev = money(cust.remainingBalance);
  const bal = money(prev - amount);
  const tx = makeTx("ctx", "سداد دفعة حساب", amount, prev, bal, (notes || "").trim() || "سداد دفعة حساب نقدية من العميل", method || "نقدي", {}, nowIso);
  const patch = {
    remainingBalance: bal, balance: bal, totalPaid: money((cust.totalPaid || 0) + amount),
    updatedAt: nowIso, transactions: appended(cust, tx),
  };
  return { tx, patch };
}

export function supplierMovement(supp: Record<string, any>, amountIn: unknown, kind: string, notes: string, method: string, nowIso: string) {
  const amount = money(amountIn);
  if (amount <= 0) throw badRequest("المبلغ يجب أن يكون أكبر من صفر", "INVALID_AMOUNT");
  if (kind !== "payment" && kind !== "charge") throw badRequest("نوع العملية غير صالح", "VALIDATION_ERROR");

  const prev = money(supp.remainingBalance);
  let next: number, txType: string, defaultNote: string;
  const patch: Record<string, any> = {};
  if (kind === "charge") {
    next = prev + amount;
    patch.totalPurchases = money((supp.totalPurchases || 0) + amount);
    txType = "إضافة مستحقات / فاتورة بضاعة"; defaultNote = "إضافة مستحقات / فاتورة بضاعة جديدة";
  } else {
    next = prev - amount;
    patch.totalPaid = money((supp.totalPaid || 0) + amount);
    txType = "سداد دفعة"; defaultNote = "سداد دفعة حساب للمورد";
  }
  const bal = money(next);
  const tx = makeTx("tx", txType, amount, prev, bal, (notes || "").trim() || defaultNote, method || "نقدي", {}, nowIso);
  Object.assign(patch, { remainingBalance: bal, balance: bal, updatedAt: nowIso, transactions: appended(supp, tx) });
  return { tx, patch };
}

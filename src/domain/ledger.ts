/**
 * Customer / supplier running-account ledgers.
 *
 * The ledger lines live in the entity's `transactions` JSON column (the shape the screens already read);
 * all changes go through these helpers so balance and ledger always move together, inside the caller's
 * transaction. Entities are plain row objects: the helpers mutate them in memory and the caller persists
 * the row (see `saveRow` in common.ts).
 */
import { utcnowIso } from "../core/timeutil";
import { cashMethod } from "../core/payments";
import { badRequest, dumps, loadsList, money, newId } from "./common";

type Entity = Record<string, any>;

export function appendTx(entity: Entity, tx: Record<string, any>): void {
  const txs = loadsList(entity.transactions);
  txs.push(tx);
  entity.transactions = dumps(txs);
}

export function makeTx(
  prefix: string,
  txType: string,
  amount: number,
  previous: number,
  newBalance: number,
  notes: string,
  method: string,
  extra: Record<string, any> = {},
): Record<string, any> {
  return {
    id: `${prefix}_${newId().slice(0, 12)}`,
    date: utcnowIso(),
    type: txType,
    amount: money(amount),
    previousBalance: money(previous),
    newBalance: money(newBalance),
    notes,
    method,
    ...extra,
  };
}

export function customerSetBalance(cust: Entity, newBalance: number): void {
  cust.remainingBalance = money(newBalance);
  cust.balance = cust.remainingBalance;
}

export function customerPayment(cust: Entity, amount: number, notes = "", method = cashMethod()): Record<string, any> {
  amount = money(amount);
  if (amount <= 0) throw badRequest("المبلغ يجب أن يكون أكبر من صفر", "INVALID_AMOUNT");
  const prev = money(cust.remainingBalance);
  customerSetBalance(cust, prev - amount);
  cust.totalPaid = money((cust.totalPaid || 0) + amount);
  cust.updatedAt = utcnowIso();
  const tx = makeTx(
    "ctx", "سداد دفعة حساب", amount, prev, cust.remainingBalance,
    (notes || "").trim() || "سداد دفعة حساب نقدية من العميل", method || cashMethod(),
  );
  appendTx(cust, tx);
  return tx;
}

export function supplierMovement(
  supp: Entity, amount: number, kind = "payment", notes = "", method = cashMethod(),
): Record<string, any> {
  amount = money(amount);
  if (amount <= 0) throw badRequest("المبلغ يجب أن يكون أكبر من صفر", "INVALID_AMOUNT");
  if (kind !== "payment" && kind !== "charge") throw badRequest("نوع العملية غير صالح", "VALIDATION_ERROR");

  const prev = money(supp.remainingBalance);
  let next: number, txType: string, defaultNote: string;
  if (kind === "charge") {
    next = prev + amount;
    supp.totalPurchases = money((supp.totalPurchases || 0) + amount);
    txType = "إضافة مستحقات / فاتورة بضاعة";
    defaultNote = "إضافة مستحقات / فاتورة بضاعة جديدة";
  } else {
    next = prev - amount;
    supp.totalPaid = money((supp.totalPaid || 0) + amount);
    txType = "سداد دفعة";
    defaultNote = "سداد دفعة حساب للمورد";
  }

  supp.remainingBalance = money(next);
  supp.balance = supp.remainingBalance;
  supp.updatedAt = utcnowIso();
  const tx = makeTx("tx", txType, amount, prev, supp.remainingBalance, (notes || "").trim() || defaultNote, method || cashMethod());
  appendTx(supp, tx);
  return tx;
}

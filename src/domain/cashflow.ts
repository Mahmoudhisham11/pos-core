/**
 * Money that actually moved, per channel (cash drawer / card / wallets & transfers), between two moments.
 * One definition used by the shift close (expected cash in the drawer) and by the treasury, so they always agree.
 *
 * Cash events and when they happen:
 *  + sales            the amount received at the sale (cash sale: the total, change excluded; credit sale: its down payment)
 *  - sales returns    the money handed back (stored on the return as cashRefund + refundMethod)
 *  + collections      customer debt payments
 *  - supplier money   payments to suppliers and the amount paid on purchase invoices
 *  + purchase returns money a supplier gave back (the part of the refund that did not just reduce our debt)
 *  - expenses         expense payments
 *  - advances         employee advances / withdrawals (paid from the drawer)
 *  +/- treasury       manual deposits, withdrawals and transfers between channels
 */
import type { SqlDriver } from "../db/types";
import { loadsList, money } from "./common";

export type Channel = "cash" | "visa" | "wallets";
export const CHANNEL_LABEL: Record<Channel, string> = { cash: "نقدي", visa: "فيزا", wallets: "تحويل / محافظ" };

/** Payment method -> channel. A credit sale's down payment is taken in cash. */
export function channelOf(method: unknown): Channel {
  const m = String(method ?? "").trim().toLowerCase();
  if (!m || ["نقدي", "كاش", "cash", "آجل", "اجل"].includes(m)) return "cash";
  if (["فيزا", "visa", "بطاقة", "بطاقة بنكية", "card"].includes(m) || m.startsWith("فيزا")) return "visa";
  return "wallets";
}

const KINDS = ["sales", "refunds", "collections", "supplierPayments", "purchasePayments", "purchaseRefunds", "expenses", "advances", "treasuryIn", "treasuryOut"] as const;
type Kind = (typeof KINDS)[number];
const OUTFLOW: ReadonlySet<Kind> = new Set(["refunds", "supplierPayments", "purchasePayments", "expenses", "advances", "treasuryOut"]);

export interface ChannelFlow { in: number; out: number; net: number; byKind: Record<Kind, number> }
export type CashFlow = Record<Channel, ChannelFlow>;

const t = (v: unknown): number => {
  const n = Date.parse(String(v ?? ""));
  return Number.isFinite(n) ? n : NaN;
};

export function computeCashFlow(db: SqlDriver, fromIso: string | null, toIso: string | null = null): CashFlow {
  const from = fromIso ? t(fromIso) : -Infinity;
  const to = toIso ? t(toIso) : Infinity;
  const inWindow = (when: unknown) => { const x = t(when); return Number.isFinite(x) && x >= from && x <= to; };

  const flow = {} as CashFlow;
  for (const ch of ["cash", "visa", "wallets"] as Channel[]) {
    flow[ch] = { in: 0, out: 0, net: 0, byKind: Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number> };
  }
  const add = (ch: Channel, kind: Kind, amount: number) => {
    const a = Number(amount) || 0;
    if (a <= 0) return;
    flow[ch].byKind[kind] += a;
  };

  // returns first: a sale's stored paidAmount is already reduced by the cash it gave back
  const refundsBySale = new Map<string, number>();
  for (const r of db.all<any>(`SELECT * FROM sales_returns`)) {
    const cash = Number(r.cashRefund ?? 0) || 0;
    if (r.invoiceId) refundsBySale.set(String(r.invoiceId), (refundsBySale.get(String(r.invoiceId)) ?? 0) + cash);
    if (inWindow(r.createdAt)) add(channelOf(r.refundMethod || "نقدي"), "refunds", cash);
  }

  for (const s of db.all<any>(`SELECT id, paymentMethod, total, paidAmount, createdAt FROM sales`)) {
    if (!inWindow(s.createdAt)) continue;
    const method = s.paymentMethod || "نقدي";
    const isCredit = channelOf(method) === "cash" && !["نقدي", "كاش", "cash"].includes(String(method).trim().toLowerCase());
    const paidNow = Number(s.paidAmount) || 0;
    const original = paidNow + (refundsBySale.get(String(s.id)) ?? 0);
    // the drawer keeps at most the invoice total (any change is handed back immediately)
    const received = isCredit ? original : Math.min(original, (Number(s.total) || 0) + (refundsBySale.get(String(s.id)) ?? 0));
    add(channelOf(method), "sales", received);
  }

  for (const c of db.all<any>(`SELECT transactions FROM customers`)) {
    for (const tx of loadsList(c.transactions)) {
      if (!inWindow(tx.date)) continue;
      if (String(tx.type || "").startsWith("سداد") || tx.type === "payment") add(channelOf(tx.method), "collections", Number(tx.amount));
    }
  }

  for (const s of db.all<any>(`SELECT transactions FROM suppliers`)) {
    for (const tx of loadsList(s.transactions)) {
      if (!inWindow(tx.date)) continue;
      const type = String(tx.type || "");
      if (type.startsWith("سداد") || type === "payment") add(channelOf(tx.method), "supplierPayments", Number(tx.amount));
      else if (type === "مرتجع مشتريات") {
        // the part of the refund that did not just reduce what we owe came back as money
        const debtCut = Math.max(0, (Number(tx.previousBalance) || 0) - (Number(tx.newBalance) || 0));
        add("cash", "purchaseRefunds", (Number(tx.amount) || 0) - debtCut);
      }
    }
  }

  for (const p of db.all<any>(`SELECT paidAmount, paymentMethod, createdAt FROM shop_purchases`)) {
    if (inWindow(p.createdAt)) add(channelOf(p.paymentMethod), "purchasePayments", Number(p.paidAmount));
  }

  for (const m of db.all<any>(`SELECT transactions, expenses FROM monthly_expenses`)) {
    const txs = loadsList(m.transactions);
    for (const tx of txs.length ? txs : loadsList(m.expenses)) {
      if (inWindow(tx.date || tx.createdAt)) add(channelOf(tx.method), "expenses", Number(tx.amount));
    }
  }

  for (const e of db.all<any>(`SELECT amount, createdAt, date FROM employee_transactions WHERE type='advance'`)) {
    if (inWindow(e.createdAt || e.date)) add("cash", "advances", Number(e.amount));
  }

  for (const tx of db.all<any>(`SELECT * FROM treasury_transactions`)) {
    if (!inWindow(tx.createdAt || tx.date)) continue;
    const amt = Number(tx.amount) || 0;
    const type = String(tx.type || "");
    if (["إيداع", "deposit", "in"].includes(type)) add(channelOf(tx.fromMethod), "treasuryIn", amt);
    else if (["سحب", "withdraw", "withdrawal", "out"].includes(type)) add(channelOf(tx.fromMethod), "treasuryOut", amt);
    else if (["تحويل", "transfer"].includes(type)) {
      add(channelOf(tx.fromMethod), "treasuryOut", amt);
      if (tx.destination) add(channelOf(tx.destination), "treasuryIn", amt);
    }
  }

  for (const ch of Object.keys(flow) as Channel[]) {
    const f = flow[ch];
    for (const k of KINDS) {
      f.byKind[k] = money(f.byKind[k]);
      if (OUTFLOW.has(k)) f.out += f.byKind[k];
      else f.in += f.byKind[k];
    }
    f.in = money(f.in);
    f.out = money(f.out);
    f.net = money(f.in - f.out);
  }
  return flow;
}

/** Where the current (open) shift starts: right after the last closed shift, or at its first invoice. */
export function openShiftStart(db: SqlDriver): string | null {
  const last = db.get<{ c: string | null }>(`SELECT MAX(closedAt) AS c FROM shift_reports`)?.c ?? null;
  if (last) return last;
  return db.get<{ c: string | null }>(`SELECT MIN(createdAt) AS c FROM sales WHERE shiftReportId IS NULL`)?.c ?? null;
}

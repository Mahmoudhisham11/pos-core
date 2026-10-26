/**
 * Payment methods as configured by the app (`settings.PAYMENT_METHODS`): which money channel each one moves, which
 * one is the default cash method and which one is "pay later". Nothing else in the core names a method.
 */
import { settings, type Channel, type PaymentMethod } from "./config";

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();
const spellings = (m: PaymentMethod): string[] => [m.name, ...(m.aliases ?? [])].map(norm);

/** The configured method a stored / requested value means (exact name or alias, then `matchPrefix` names). */
export function findMethod(value: unknown): PaymentMethod | undefined {
  const v = norm(value);
  if (!v) return undefined;
  const list = settings.PAYMENT_METHODS;
  return list.find((m) => spellings(m).includes(v)) ?? list.find((m) => m.matchPrefix && v.startsWith(norm(m.name)));
}

/** The method used when a request names none: the first cash method that is not "pay later". */
export function cashMethod(): string {
  return settings.PAYMENT_METHODS.find((m) => m.channel === "cash" && !m.credit)?.name ?? "cash";
}

/** The "pay later" method, if the app has one. */
export function creditMethod(): string | null {
  return settings.PAYMENT_METHODS.find((m) => m.credit)?.name ?? null;
}

export const isCreditMethod = (value: unknown): boolean => !!findMethod(value)?.credit;

/** The configured name of a value ("cash" -> "نقدي"); unknown values are kept as sent, empty means cash. */
export function canonicalMethod(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return cashMethod();
  return findMethod(s)?.name ?? s;
}

/** Payment method -> channel. A credit sale's down payment is taken in cash; unknown methods count as wallets. */
export function channelOf(method: unknown): Channel {
  if (!norm(method)) return "cash";
  return findMethod(method)?.channel ?? "wallets";
}

export const methodNames = (): string[] => settings.PAYMENT_METHODS.map((m) => m.name);

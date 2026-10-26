/** Where the money of a payment method goes: the cash drawer, card terminal, or wallets / bank transfers. */
export type Channel = "cash" | "visa" | "wallets";

export interface PaymentMethod {
  /** The name stored on invoices and shown to the user ("نقدي", "فيزا"...). */
  name: string;
  channel: Channel;
  /** The "pay later" method: nothing is collected at the sale unless a down payment is sent. */
  credit?: boolean;
  /** Other spellings that mean the same method ("cash", "كاش"...). */
  aliases?: string[];
  /** Any value starting with `name` is this method too ("فيزا بنك مصر" -> "فيزا"). */
  matchPrefix?: boolean;
}

const env = (k: string): string | undefined => (typeof process !== "undefined" ? process.env?.[k] : undefined);

/**
 * Port of core/config.py. The per-install secret is persisted by the host (desktop shell) and passed in through
 * `configure({ SECRET_KEY })`; without it a process-lifetime random secret is used (tokens die on restart).
 */
export const settings = {
  APP_NAME: "POS Core API",
  APP_ENV: "development",
  DEBUG: false,
  API_V1_STR: "/api",
  SECRET_KEY: env("SECRET_KEY") ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
  ALGORITHM: "HS256",
  ACCESS_TOKEN_EXPIRE_MINUTES: 60 * 24 * 30, // 30 days
  LOGIN_MAX_FAILURES: 5,
  LOGIN_LOCK_SECONDS: 60,
  PASSWORD_MIN_LENGTH: 4,
  DEVICE_ID: "desktop-local-01",
  /** Firebase project whose accounts may log in on this device (set by the host). Empty = cloud login disabled. */
  FIREBASE_PROJECT_ID: env("NEXT_PUBLIC_FIREBASE_PROJECT_ID") ?? "",

  // ---- Per-app branding: every frontend passes its own values through configure() ----
  /** Prefix of the cloud (Firestore) collection names: `${prefix}sales`, `${prefix}shop_products`... */
  COLLECTION_PREFIX: "pos_",
  /** Brand stored on a new product when the request names none. */
  DEFAULT_BRAND: "",
  /** Category of a new product when the request names none. */
  DEFAULT_CATEGORY: "أخرى",
  BRANCH_NAME: "الفرع الرئيسي",
  SHOP_LOCATION_NAME: "المحل",
  WAREHOUSE_LOCATION_NAME: "المخزن الرئيسي",

  // ---- Money: currency and payment methods (see core/payments.ts) ----
  /** ISO code reported with account balances. */
  CURRENCY: "EGP",
  /** Written after amounts in ledger notes and messages. */
  CURRENCY_SYMBOL: "ج.م",
  /** Payment methods in display order. The first cash, non-credit one is the default when a request names none. */
  PAYMENT_METHODS: [
    { name: "نقدي", channel: "cash", aliases: ["كاش", "cash"] },
    { name: "فيزا", channel: "visa", aliases: ["visa", "بطاقة", "بطاقة بنكية", "card"], matchPrefix: true },
    { name: "تحويل", channel: "wallets" },
    { name: "آجل", channel: "cash", credit: true, aliases: ["اجل"] },
  ] as PaymentMethod[],
  /** Customer name on a sale without a registered customer. */
  DEFAULT_CUSTOMER_NAME: "عميل نقدي",
  /** Type of a new customer when the request names none. */
  DEFAULT_CUSTOMER_TYPE: "قطاعي",
};

export function configure(patch: Partial<typeof settings>): void {
  Object.assign(settings, patch);
}

import { settings } from "./config";

/**
 * Cloud collection <-> local table (port of sync_hooks.COLLECTION_TABLE_MAP). The collection names are
 * `settings.COLLECTION_PREFIX` + the suffix below, so every app built on this core keeps its own names
 * (prefix "nelly_" -> "nelly_sales"...). Users are pulled from the cloud but never pushed.
 * The outbox capture itself lives in db/sql.ts (insertRow/updateRow/deleteRow).
 */
const SUFFIX_TABLE: Array<[string, string]> = [
  ["users", "users"],
  ["shop_products", "shop_products"],
  ["products", "products"],
  ["transfers", "transfers"],
  ["sales", "sales"],
  ["reports", "shift_reports"],
  ["returns", "sales_returns"],
  ["customers", "customers"],
  ["suppliers", "suppliers"],
  ["shop_purchases", "shop_purchases"],
  ["shop_purchase_returns", "shop_purchase_returns"],
  ["employees", "employees"],
  ["employee_attendance", "employee_attendance"],
  ["employee_transactions", "employee_transactions"],
  ["expense_items", "expense_items"],
  ["monthly_expenses", "monthly_expenses"],
  ["treasury_transactions", "treasury_transactions"],
  ["stock_movements", "stock_movements"],
];

let cache: { prefix: string; c2t: Record<string, string>; t2c: Record<string, string> } | null = null;

function maps() {
  const prefix = settings.COLLECTION_PREFIX ?? "";
  if (!cache || cache.prefix !== prefix) {
    const c2t = Object.fromEntries(SUFFIX_TABLE.map(([s, t]) => [prefix + s, t]));
    const t2c = Object.fromEntries(SUFFIX_TABLE.map(([s, t]) => [t, prefix + s]));
    cache = { prefix, c2t, t2c };
  }
  return cache;
}

/** collection name -> table, for the configured prefix. */
export const collectionTableMap = (): Record<string, string> => maps().c2t;
/** table -> collection name, for the configured prefix. */
export const tableCollectionMap = (): Record<string, string> => maps().t2c;

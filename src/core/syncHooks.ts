/**
 * collection -> table (port of sync_hooks.COLLECTION_TABLE_MAP). Users are pulled from the cloud but never pushed.
 * The outbox capture itself lives in db/sql.ts (insertRow/updateRow/deleteRow).
 */
export const COLLECTION_TABLE_MAP: Record<string, string> = {
  nelly_users: "users",
  nelly_shop_products: "shop_products",
  nelly_products: "products",
  nelly_transfers: "transfers",
  nelly_sales: "sales",
  nelly_reports: "shift_reports",
  nelly_returns: "sales_returns",
  nelly_customers: "customers",
  nelly_suppliers: "suppliers",
  nelly_shop_purchases: "shop_purchases",
  nelly_shop_purchase_returns: "shop_purchase_returns",
  nelly_employees: "employees",
  nelly_employee_attendance: "employee_attendance",
  nelly_employee_transactions: "employee_transactions",
  nelly_expense_items: "expense_items",
  nelly_monthly_expenses: "monthly_expenses",
  nelly_treasury_transactions: "treasury_transactions",
};

export const TABLE_COLLECTION_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(COLLECTION_TABLE_MAP).map(([c, t]) => [t, c]),
);

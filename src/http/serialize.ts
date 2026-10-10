/** Port of app/core/serializer.py: JSON-text columns are parsed and camelCase/snake_case aliases added. */
export function parseJsonSafely(val: unknown): unknown {
  if (!val || typeof val !== "string") return val;
  const s = val.trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { return JSON.parse(s); } catch { return val; }
  }
  return val;
}

// key -> aliases it also produces
export const ALIASES: Record<string, string[]> = {
  costPrice: ["cost_price", "default_cost_price"], wholesalePrice: ["wholesale_price"],
  sellingPrice: ["selling_price", "price", "retail_price"], minThreshold: ["min_threshold", "minStock", "min_stock"],
  invoiceNumber: ["invoice_number"], customerName: ["customer_name"], sellerEmployee: ["seller_employee"],
  paymentMethod: ["payment_method"], discountType: ["discount_type"], paidAmount: ["paid_amount"],
  remainingDue: ["remaining_due", "remainingBalance", "remaining_balance"], changeDue: ["change_due"],
  totalCost: ["total_cost"], totalProfit: ["total_profit"], itemsCount: ["items_count"], reportNumber: ["report_number"],
  closedAt: ["closed_at"], closedBy: ["closed_by"], openingCash: ["opening_cash"],
  closingCashActual: ["closing_cash_actual"], closingCashExpected: ["closing_cash_expected"],
  totalSales: ["total_sales"], totalPaid: ["total_paid"], totalDiscount: ["total_discount"],
  totalExpenses: ["total_expenses"], totalPurchases: ["total_purchases"], totalItemsSold: ["total_items_sold"],
  invoicesCount: ["invoices_count"], paymentBreakdown: ["payment_breakdown"], returnNumber: ["return_number"],
  invoiceId: ["invoice_id"], originalInvoiceId: ["original_invoice_id"], refundedAmount: ["refunded_amount"],
  returnedItems: ["returned_items"], returnReason: ["return_reason"], totalRefund: ["total_refund"],
  deleteIfZero: ["delete_if_zero"], remainingBalance: ["remaining_balance", "remainingDue", "remaining_due"],
  totalAmount: ["total_amount"], createdBy: ["created_by"], baseSalary: ["base_salary"], commissionRate: ["commission_rate"],
  hireDate: ["hire_date", "joinDate", "join_date"], joinDate: ["join_date", "hireDate", "hire_date"],
  employeeId: ["employee_id"], employeeName: ["employee_name"], employeeCode: ["employee_code"], shiftId: ["shift_id"],
  checkIn: ["check_in"], checkOut: ["check_out"], durationMinutes: ["duration_minutes"], monthStr: ["month_str"],
  createdByUser: ["created_by_user"], itemId: ["item_id"], itemName: ["item_name"], fromMethod: ["from_method"],
  dateStr: ["date_str"], productId: ["product_id"], productName: ["product_name"],
  quantity: ["stock"], stock: ["quantity"],
};

export function serializeRow(row: Record<string, any> | null | undefined): Record<string, any> {
  if (!row) return {};
  const raw: Record<string, any> = { ...row };
  delete raw.password; delete raw.pin;
  const res: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    const pv = parseJsonSafely(v);
    res[k] = pv;
    const al = ALIASES[k];
    if (al) for (const a of al) res[a] = pv;
    if (k === "displayName") { res.display_name = pv; res.name = res.name || pv; }
    else if (k === "isActive") res.is_active = Boolean(pv);
  }
  if ("id" in res) res.local_id = res.id;
  return res;
}
export const serializeList = (rows: Array<Record<string, any>>) => rows.map(serializeRow);

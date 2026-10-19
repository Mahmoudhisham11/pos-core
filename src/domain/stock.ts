/**
 * Stock movement log: one row for every change of a product's quantity (sale, return, purchase, transfer, stock-take,
 * manual edit...), with who did it and the document behind it. Rows are only ever inserted, and they sync like any
 * other record, so every device ends up with the full history of every product.
 */
import type { SqlDriver } from "../db/types";
import { insertRow } from "../db/sql";
import { currentActor } from "../core/actor";
import { EPS, newId, qtyRound } from "./common";

export type ProductTable = "products" | "shop_products";

export type MovementType =
  | "sale" | "sale_void" | "sale_return"
  | "purchase" | "purchase_return"
  | "transfer_in" | "transfer_out"
  | "opening" | "restock" | "adjustment" | "deleted";

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  sale: "بيع",
  sale_void: "إلغاء فاتورة بيع",
  sale_return: "مرتجع مبيعات",
  purchase: "فاتورة مشتريات",
  purchase_return: "مرتجع مشتريات",
  transfer_in: "تحويل وارد",
  transfer_out: "تحويل صادر",
  opening: "رصيد أول المدة",
  restock: "إضافة كمية",
  adjustment: "جرد / تعديل يدوي",
  deleted: "حذف الصنف",
};

export interface MovementMeta {
  type: MovementType;
  refType?: string;
  refNumber?: string;
  reason?: string;
}

/** Records `before -> after` for `prod` (nothing when the quantity did not change). */
export function logMovement(
  db: SqlDriver, table: ProductTable, prod: Record<string, any>, before: number, after: number, meta: MovementMeta, now: string,
): void {
  const change = qtyRound(Number(after || 0) - Number(before || 0));
  if (Math.abs(change) <= EPS) return;
  const actor = currentActor();
  insertRow(db, "stock_movements", {
    id: newId(),
    productId: prod.id,
    productName: prod.name || "",
    barcode: prod.barcode || "",
    location: table === "products" ? "warehouse" : "shop",
    type: meta.type,
    change,
    quantityBefore: qtyRound(before || 0),
    quantityAfter: qtyRound(after || 0),
    refType: meta.refType || null,
    refNumber: meta.refNumber || null,
    reason: meta.reason || "",
    userId: actor.id,
    userName: actor.name,
    createdAt: now,
  });
}

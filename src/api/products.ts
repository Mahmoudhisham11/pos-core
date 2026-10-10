import type { Router } from "../http/router";
import { registerProductCrud } from "./stockCommon";

/** /products - warehouse catalogue. */
export function registerProducts(router: Router): void {
  registerProductCrud(router, "/products", "products", {
    defaultThreshold: 5,
    notFoundGet: "المنتج غير موجود في المخزن",
    notFoundMutate: "المنتج غير موجود",
    deleted: "تم حذف الصنف من المخزن",
  });
}

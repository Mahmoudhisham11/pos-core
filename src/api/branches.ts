import { settings } from "../core/config";
import type { Router } from "../http/router";

/** Single branch with a shop and a warehouse location; the display names come from the app's configure(). */
export function registerBranches(router: Router): void {
  router.get("/branches", () => [
    {
      id: "branch-main",
      name: settings.BRANCH_NAME,
      code: "MAIN",
      is_active: true,
      locations: [
        { id: "loc-shop-01", name: settings.SHOP_LOCATION_NAME, code: "loc-shop-01", type: "SHOP" },
        { id: "loc-wh-01", name: settings.WAREHOUSE_LOCATION_NAME, code: "loc-wh-01", type: "WAREHOUSE" },
      ],
    },
  ]);
}

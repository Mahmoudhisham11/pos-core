import type { Router } from "../http/router";

export function registerBranches(router: Router): void {
  router.get("/branches", () => [
    {
      id: "branch-main",
      name: "مخزن ومحل Nelly الرئيسي",
      code: "MAIN",
      is_active: true,
      locations: [
        { id: "loc-shop-01", name: "معرض ومحل Nelly", code: "loc-shop-01", type: "SHOP" },
        { id: "loc-wh-01", name: "المخزن الرئيسي", code: "loc-wh-01", type: "WAREHOUSE" },
      ],
    },
  ]);
}

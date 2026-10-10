import { getUserPermissions } from "../core/auth";
import type { Router } from "../http/router";

// Roles are fixed (see core/auth); this endpoint only describes them.
const ROLES: Array<[string, string, string]> = [
  ["admin", "ADMIN", "مسؤول النظام"],
  ["manager", "MANAGER", "مدير"],
  ["cashier", "CASHIER", "كاشير / نقطة بيع"],
];

export function registerRoles(router: Router): void {
  router.get("/roles", () =>
    ROLES.map(([key, name, label]) => ({ id: `role-${key}`, name, display_name: label, permissions: getUserPermissions(key) })),
  );
}

import { authenticate } from "./core/auth";
import { settings } from "./core/config";
import { noopCloudSync, type CloudSync } from "./core/cloudSync";
import { startShiftScheduler } from "./core/shiftScheduler";
import { runMigrations } from "./db/migrations";
import type { SqlDriver } from "./db/types";
import { closeStaleShifts } from "./domain/shifts";
import { Router } from "./http/router";
import type { ApiRequest, ApiResponse } from "./http/types";
import { registerAuth } from "./api/auth";
import { registerCloud } from "./api/cloud";
import { CLOUD_LINK, CloudAuthError, firestoreVerifier, type CloudVerifier } from "./core/cloudAccount";
import { registerBranches } from "./api/branches";
import { registerCategories } from "./api/categories";
import { registerCustomers } from "./api/customers";
import { registerEmployees } from "./api/employees";
import { registerExpenses } from "./api/expenses";
import { registerHealth } from "./api/health";
import { registerMeta } from "./api/meta";
import { registerProductGroups } from "./api/productGroups";
import { registerInventory } from "./api/inventory";
import { registerProducts } from "./api/products";
import { registerRoles } from "./api/roles";
import { registerSales } from "./api/sales";
import { registerShifts } from "./api/shifts";
import { registerShop } from "./api/shop";
import { registerSuppliers } from "./api/suppliers";
import { registerSync } from "./api/sync";
import { registerTreasury } from "./api/treasury";
import { registerUsers } from "./api/users";

export {
  authenticate, requireAdmin, requireManager, requirePermission, getUserPermissions, normalizeRole, VALID_ROLES,
} from "./core/auth";
export { runMigrations } from "./db/migrations";
export { wrapWasmSqlite } from "./db/wasmSqlite";
export { configure, settings } from "./core/config";
export { collectionTableMap, tableCollectionMap } from "./core/syncHooks";
export { syncCollections, CORE_VERSION } from "./api/meta";
export { applyItems } from "./api/sync";
export { canonicalMethod, cashMethod, channelOf, creditMethod, findMethod, isCreditMethod, methodNames } from "./core/payments";
export type { Channel, PaymentMethod } from "./core/config";
export type { CloudSync } from "./core/cloudSync";
export type { CloudLink, CloudVerifier } from "./core/cloudAccount";
export type { ApiRequest, ApiResponse } from "./http/types";
export type { SqlDriver } from "./db/types";

export interface Backend {
  handle(req: ApiRequest): Promise<ApiResponse>;
  db: SqlDriver;
  now: () => Date;
  cloudSync: CloudSync;
  /** Starts the once-a-minute shift auto-close (the legacy lifespan hook); returns the stop function. */
  startScheduler(intervalMs?: number): () => void;
}

export function createBackend(db: SqlDriver, opts: { now?: () => Date; cloudSync?: CloudSync; cloudVerify?: CloudVerifier } = {}): Backend {
  const cloudVerify = opts.cloudVerify ?? firestoreVerifier;
  const now = opts.now ?? (() => new Date());
  // A half-migrated database must never serve requests: let a failure propagate.
  runMigrations(db, now());

  // Legacy include order (api/router.py): public auth + health first, then the protected routers.
  const router = new Router();
  registerAuth(router);
  registerCloud(router);
  registerHealth(router);
  registerMeta(router);
  registerUsers(router);
  registerRoles(router);
  registerBranches(router);
  registerShop(router);
  registerProductGroups(router, "/shop/product-groups", "shop_products", 3);
  registerProducts(router);
  registerProductGroups(router, "/product-groups", "products", 5);
  registerCategories(router);
  registerInventory(router);
  registerSales(router);
  registerShifts(router);
  registerCustomers(router);
  registerSuppliers(router);
  registerEmployees(router);
  registerExpenses(router);
  registerTreasury(router);
  registerSync(router);

  const deps = { authenticate, now };
  return {
    db,
    now,
    cloudSync: opts.cloudSync ?? noopCloudSync,
    async handle(req) {
      // The UI writes some queries inline ("/shop/products?limit=5000"); a real HTTP server would split them, so do it here.
      const qi = req.path.indexOf("?");
      const query: Record<string, string> = { ...(req.query ?? {}) };
      if (qi >= 0) {
        new URLSearchParams(req.path.slice(qi + 1)).forEach((v, k) => { if (!(k in query)) query[k] = v; });
        req = { ...req, path: req.path.slice(0, qi) };
      }
      const path = req.path === "/api" ? "/" : req.path.startsWith("/api/") ? req.path.slice(4) : req.path;
      if (req.method.toUpperCase() === "GET" && path === "/") {
        return { status: 200, body: { app: settings.APP_NAME, status: "online", api: settings.API_V1_STR } };
      }
      const clean: ApiRequest = { ...req, path, headers: req.headers ?? {}, query };
      if (req.method.toUpperCase() === "POST" && path.replace(/\/$/, "") === "/auth/cloud-login") {
        // the cloud proof is asynchronous, so it happens here, before the (synchronous) route runs
        try {
          const b = req.body ?? {};
          (clean as any)[CLOUD_LINK] = await cloudVerify(String(b.idToken ?? ""), String(b.uid ?? ""));
        } catch (e) {
          const message = e instanceof CloudAuthError ? e.message : "تعذر التحقق من الحساب السحابي. تأكد من الإنترنت.";
          return { status: 401, body: { error_code: "CLOUD_AUTH_FAILED", message, details: {} } };
        }
      }
      return router.dispatch(db, clean, deps);
    },
    startScheduler(intervalMs) {
      return startShiftScheduler(db, now, (d, n) => closeStaleShifts(d, n), intervalMs);
    },
  };
}

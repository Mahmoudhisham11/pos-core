import { settings } from "../core/config";
import { utcnowIso } from "../core/timeutil";
import type { Router } from "../http/router";

/** Public liveness probe (served at /health and /api/health). */
export function registerHealth(router: Router): void {
  router.get("/health", (ctx) => {
    let dbOk = true;
    try { ctx.db.get("SELECT 1"); } catch { dbOk = false; }
    return {
      status: dbOk ? "ok" : "degraded",
      app_name: settings.APP_NAME,
      database: dbOk ? "healthy" : "unhealthy",
      timestamp: utcnowIso(ctx.now()),
    };
  }, { public: true });
}

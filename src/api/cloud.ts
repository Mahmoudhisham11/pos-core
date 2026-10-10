import { appException, normalizeRole } from "../core/auth";
import { boundShop, CLOUD_LINK, getMeta, setMeta, type CloudLink } from "../core/cloudAccount";
import { hashPassword } from "../core/security";
import { utcnowIso } from "../core/timeutil";
import { getById, insertRow, updateRow } from "../db/sql";
import { respond, type Router } from "../http/router";
import { tokenResponse } from "./auth";

export function registerCloud(router: Router): void {
  /**
   * Log in with a cloud account (body: { password }). Only reachable through Backend.handle, which first verifies the
   * Firebase ID token and attaches the account's membership to the request (CLOUD_LINK). Binds an unbound database
   * to the account's shop, refuses a database of another shop, and mirrors the account into the local users table.
   */
  router.post("/auth/cloud-login", (ctx) => {
    const link: CloudLink | undefined = (ctx.req as any)[CLOUD_LINK];
    if (!link) throw appException(401, "يجب تسجيل الدخول عبر الحساب السحابي.", "CLOUD_AUTH_REQUIRED");
    const password = String(ctx.body?.password ?? "").trim();
    if (!password) throw appException(400, "يرجى إدخال كلمة المرور.", "VALIDATION_ERROR");

    const bound = boundShop(ctx.db);
    if (bound && bound !== link.shopId) {
      throw appException(409, "قاعدة البيانات المفتوحة تخص محلاً آخر.", "WRONG_SHOP_DATABASE");
    }
    if (!bound) setMeta(ctx.db, "shopId", link.shopId);
    const now = utcnowIso(ctx.now());

    if (!link.active) {
      // stopped by the shop's admin: also stop the local copy so the account cannot log in offline either
      ctx.db.run(`UPDATE users SET "isActive"=0, "updatedAt"=? WHERE id=? OR (email IS NOT NULL AND lower(email)=?)`, [now, link.uid, link.email]);
      return respond(401, { error_code: "ACCOUNT_DISABLED", message: "هذا الحساب موقوف. تواصل مع مسؤول المحل.", details: {} });
    }

    const role = normalizeRole(link.role);
    const existing: any = (link.email && ctx.db.get(`SELECT * FROM users WHERE lower(email)=? LIMIT 1`, [link.email]))
      || getById(ctx.db, "users", link.uid);
    const profile: Record<string, unknown> = {
      email: link.email || existing?.email || null,
      role,
      isActive: 1,
      password: hashPassword(password), // same password works offline on this device
      updatedAt: now,
    };
    if (link.name) { profile.name = link.name; profile.displayName = link.name; }
    if (link.branch) profile.branch = link.branch;

    if (existing) {
      updateRow(ctx.db, "users", existing.id, profile);
      return tokenResponse(getById(ctx.db, "users", existing.id)!);
    }
    const name = link.name || (link.email ? link.email.split("@")[0]! : "مستخدم");
    insertRow(ctx.db, "users", {
      id: link.uid, name, displayName: name, pin: null, createdAt: now, branch: link.branch || null, ...profile,
    });
    return tokenResponse(getById(ctx.db, "users", link.uid)!);
  }, { public: true });

  /** Which shop this database belongs to (the sync engine checks it before pushing or pulling anything). */
  router.get("/sync/bound-shop", (ctx) => ({ shopId: boundShop(ctx.db) }));

  /**
   * Pull cursors: per collection, the newest cloud change (server time, ms) this database already has. The sync
   * engine then only downloads documents changed after it, instead of re-reading the whole shop on every start.
   */
  router.get("/sync/cursors", (ctx) => {
    assertSameShop(ctx.db, ctx.query.shopId);
    const rows = ctx.db.all<{ key: string; value: string }>(`SELECT key, value FROM app_meta WHERE key LIKE 'cursor:%'`);
    return Object.fromEntries(rows.map((r) => [r.key.slice(7), Number(r.value) || 0]));
  });
  router.post("/sync/cursors", (ctx) => {
    assertSameShop(ctx.db, ctx.body?.shopId);
    const cursors = ctx.body?.cursors;
    if (!cursors || typeof cursors !== "object") throw appException(422, "cursors required", "VALIDATION_ERROR");
    for (const [col, ms] of Object.entries(cursors)) {
      if (!/^nelly_[a-z_]+$/.test(col) || !Number.isFinite(Number(ms))) continue;
      const prev = Number(getMeta(ctx.db, `cursor:${col}`)) || 0;
      if (Number(ms) > prev) setMeta(ctx.db, `cursor:${col}`, String(Math.trunc(Number(ms)))); // only moves forward
    }
    return { success: true };
  });
  router.post("/sync/cursors/reset", (ctx) => {
    assertSameShop(ctx.db, ctx.body?.shopId);
    ctx.db.run(`DELETE FROM app_meta WHERE key LIKE 'cursor:%'`);
    return { success: true };
  });
}

/** Refuses sync calls that name a different shop than the one this database belongs to. */
export function assertSameShop(db: Parameters<typeof boundShop>[0], shopId: unknown): void {
  if (shopId === undefined || shopId === null || shopId === "") return;
  const bound = boundShop(db);
  if (bound && bound !== String(shopId)) {
    throw appException(409, "قاعدة البيانات المفتوحة تخص محلاً آخر.", "WRONG_SHOP_DATABASE");
  }
}

import { appException, normalizeRole, requireAdmin, VALID_ROLES } from "../core/auth";
import { settings } from "../core/config";
import { hashPassword } from "../core/security";
import { utcnowIso } from "../core/timeutil";
import { Validator } from "../core/validation";
import type { SqlDriver } from "../db/types";
import { deleteRow, getById, insertRow, uid, updateRow } from "../db/sql";
import { httpError } from "../http/errors";
import type { Router } from "../http/router";
import { serializeList, serializeRow } from "../http/serialize";

function checkRole(role: string | null | undefined): string {
  const clean = (role || "cashier").trim().toLowerCase();
  if (!(VALID_ROLES as readonly string[]).includes(clean)) {
    throw appException(400, `الدور غير صالح. الأدوار المتاحة: ${VALID_ROLES.join(", ")}`, "VALIDATION_ERROR");
  }
  return clean;
}

function checkPassword(password: string): string {
  const clean = password.trim();
  if (clean.length < settings.PASSWORD_MIN_LENGTH) {
    throw appException(400, `كلمة المرور يجب ألا تقل عن ${settings.PASSWORD_MIN_LENGTH} أحرف.`, "VALIDATION_ERROR");
  }
  return clean;
}

function emailTaken(db: SqlDriver, email: string, excludeId?: string): boolean {
  const rows = excludeId
    ? db.get(`SELECT id FROM users WHERE lower(email)=? AND id<>? LIMIT 1`, [email.toLowerCase(), excludeId])
    : db.get(`SELECT id FROM users WHERE lower(email)=? LIMIT 1`, [email.toLowerCase()]);
  return rows !== undefined;
}

function otherActiveAdmins(db: SqlDriver, excludeId: string): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE lower(role)='admin' AND "isActive"=1 AND id<>?`, [excludeId])!.n;
}

const USER_NOT_FOUND = "المستخدم غير موجود";

export function registerUsers(router: Router): void {
  router.get("/users", (ctx) => serializeList(ctx.db.all(`SELECT * FROM users`)));

  router.post("/users", (ctx) => {
    requireAdmin(ctx);
    const b = ctx.body;
    const v = new Validator();
    const name = v.str(b, "name", { required: true, min: 1, max: 150 });
    const emailIn = v.str(b, "email");
    const displayName = v.str(b, "displayName");
    const roleIn = v.str(b, "role");
    const password = v.str(b, "password", { required: true, min: 1, max: 128 });
    const pin = v.str(b, "pin");
    const isActive = v.bool(b, "isActive");
    const branch = v.str(b, "branch", { max: 150 });
    v.done();

    const email = (emailIn || "").trim().toLowerCase() || null;
    if (email && emailTaken(ctx.db, email)) throw appException(400, "البريد الإلكتروني مسجل بالفعل بمستخدم آخر.", "DUPLICATE_USER");

    const now = utcnowIso(ctx.now());
    const row = {
      id: uid(),
      name: (name as string).trim(),
      displayName: (displayName || (name as string)).trim(),
      email,
      role: checkRole(roleIn === undefined ? "cashier" : roleIn),
      password: hashPassword(checkPassword(password as string)),
      pin: pin ?? null,
      // `isActive: Optional[bool] = True`: an explicit null is falsy -> inactive (legacy behaviour)
      isActive: (isActive === undefined ? true : isActive) ? 1 : 0,
      branch: (branch || "").trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    insertRow(ctx.db, "users", row);
    return serializeRow(getById(ctx.db, "users", row.id));
  });

  router.get("/users/{user_id}", (ctx) => {
    const user = getById(ctx.db, "users", ctx.params.user_id!);
    if (!user) throw httpError(404, USER_NOT_FOUND);
    return serializeRow(user);
  });

  router.put("/users/{user_id}", (ctx) => {
    requireAdmin(ctx);
    const b = ctx.body;
    const v = new Validator();
    const name = v.str(b, "name");
    const emailIn = v.str(b, "email");
    const displayName = v.str(b, "displayName");
    const roleIn = v.str(b, "role");
    const password = v.str(b, "password", { max: 128 });
    const pin = v.str(b, "pin");
    const isActive = v.bool(b, "isActive");
    const branch = v.str(b, "branch", { max: 150 });
    v.done();

    const user = getById<any>(ctx.db, "users", ctx.params.user_id!);
    if (!user) throw httpError(404, USER_NOT_FOUND);

    const newRole = roleIn != null ? checkRole(roleIn) : null;
    const demoting = newRole !== null && newRole !== "admin" && normalizeRole(user.role) === "admin";
    const deactivating = isActive === false && !!user.isActive;
    if ((demoting || deactivating) && otherActiveAdmins(ctx.db, user.id) === 0) {
      throw appException(400, "لا يمكن إيقاف أو تخفيض آخر مسؤول في النظام.", "LAST_ADMIN");
    }

    const patch: Record<string, unknown> = {};
    if (name != null) {
      patch.name = name.trim();
      if (!displayName) patch.displayName = name.trim();
    }
    if (displayName != null) patch.displayName = displayName.trim();
    if (emailIn != null) {
      const email = emailIn.trim().toLowerCase() || null;
      if (email && emailTaken(ctx.db, email, user.id)) throw appException(400, "البريد الإلكتروني مسجل بالفعل بمستخدم آخر.", "DUPLICATE_USER");
      patch.email = email;
    }
    if (newRole !== null) patch.role = newRole;
    if (password) patch.password = hashPassword(checkPassword(password));
    if (pin != null) patch.pin = pin;
    if (isActive != null) patch.isActive = isActive ? 1 : 0;
    if (branch != null) patch.branch = branch.trim() || null;
    patch.updatedAt = utcnowIso(ctx.now());

    updateRow(ctx.db, "users", user.id, patch);
    return serializeRow(getById(ctx.db, "users", user.id));
  });

  router.delete("/users/{user_id}", (ctx) => {
    const current = requireAdmin(ctx);
    const user = getById<any>(ctx.db, "users", ctx.params.user_id!);
    if (!user) throw httpError(404, USER_NOT_FOUND);
    if (user.id === current.id) throw appException(400, "لا يمكنك حذف حسابك الحالي.", "SELF_DELETE");
    if (normalizeRole(user.role) === "admin" && user.isActive && otherActiveAdmins(ctx.db, user.id) === 0) {
      throw appException(400, "لا يمكن حذف آخر مسؤول في النظام.", "LAST_ADMIN");
    }
    deleteRow(ctx.db, "users", user.id);
    return { success: true, message: "تم حذف المستخدم" };
  });
}

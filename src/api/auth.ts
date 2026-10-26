import {
  appException, bearerToken, getUserPermissions, normalizeRole, optionalUser,
  throttleCheck, throttleFail, throttleReset,
} from "../core/auth";
import { settings } from "../core/config";
import { createAccessToken, decodeToken, hashPassword, verifyPassword } from "../core/security";
import { utcnowIso } from "../core/timeutil";
import { Validator } from "../core/validation";
import { insertRow, uid } from "../db/sql";
import { unauthorized } from "../http/errors";
import type { Router } from "../http/router";
import { serializeRow } from "../http/serialize";

// Hash used to keep login timing similar when the user does not exist.
const DUMMY_HASH = hashPassword("pos-dummy-password");

export function userPayload(user: Record<string, any>) {
  const role = normalizeRole(user.role);
  return {
    ...serializeRow(user),
    id: user.id,
    uid: user.id,
    email: user.email,
    username: user.name || user.displayName || (user.email ? String(user.email).split("@")[0] : "user"),
    name: user.name || user.displayName,
    displayName: user.displayName || user.name,
    full_name: user.name || user.displayName,
    role,
    roles: [role.toUpperCase()],
    permissions: getUserPermissions(role),
  };
}

export function tokenResponse(user: Record<string, any>) {
  const token = createAccessToken(user.id, { email: user.email, role: normalizeRole(user.role), name: user.name });
  return { access_token: token, token_type: "bearer", user: userPayload(user) };
}

export function registerAuth(router: Router): void {
  router.post("/auth/login", (ctx) => {
    const b = ctx.body;
    const v = new Validator();
    const email = v.str(b, "email");
    const username = v.str(b, "username");
    const rawPassword = v.str(b, "password", { required: true });
    v.str(b, "device_id"); v.str(b, "pin");
    v.done();
    const identifier = (email || username || "").trim();
    const password = (rawPassword as string).trim();
    if (!identifier || !password) {
      throw appException(400, "يرجى إدخال اسم المستخدم أو البريد الإلكتروني وكلمة المرور.", "VALIDATION_ERROR");
    }
    throttleCheck(identifier);

    const needle = identifier.toLowerCase();
    const user = ctx.db.get<any>(
      `SELECT * FROM users WHERE lower(email)=? OR lower(name)=? OR lower("displayName")=? ORDER BY "isActive" DESC, "createdAt" ASC LIMIT 1`,
      [needle, needle, needle],
    );
    const passwordOk = verifyPassword(password, user ? user.password : DUMMY_HASH);
    if (!user || !passwordOk) {
      throttleFail(identifier);
      throw unauthorized("اسم المستخدم أو كلمة المرور غير صحيحة.");
    }
    if (!user.isActive) throw unauthorized("هذا الحساب موقوف. تواصل مع مسؤول المحل.");

    throttleReset(identifier);
    return tokenResponse(user);
  }, { public: true });

  // Local account creation: the very first account of a database becomes its admin; afterwards admins only.
  // (A new shop signs up through the cloud - see api/cloud.ts - and gets its own, empty database.)
  router.post("/auth/register", (ctx) => {
    const b = ctx.body;
    const v = new Validator();
    const name = v.str(b, "name");
    const fullName = v.str(b, "full_name");
    const email = v.str(b, "email");
    v.str(b, "username");
    const rawPassword = v.str(b, "password", { required: true });
    const roleIn = v.str(b, "role");
    const branchIn = v.str(b, "branch") ?? v.str(b, "shopName") ?? v.str(b, "shop_name");
    v.str(b, "device_id"); v.str(b, "pin");
    v.done();

    const current = optionalUser(ctx.db, ctx.req);
    const isBootstrap = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)!.n === 0;
    if (!isBootstrap && (current === null || normalizeRole(current.role) !== "admin")) {
      throw appException(403, "التسجيل مغلق. اطلب من المسؤول إنشاء حساب لك.", "REGISTRATION_CLOSED");
    }

    const cleanName = (name || fullName || "").trim();
    const cleanEmail = (email || "").trim().toLowerCase();
    const cleanPass = (rawPassword as string).trim();
    if (!cleanName || !cleanPass) throw appException(400, "يرجى إدخال الاسم وكلمة المرور.", "VALIDATION_ERROR");
    if (cleanPass.length < settings.PASSWORD_MIN_LENGTH) {
      throw appException(400, `كلمة المرور يجب ألا تقل عن ${settings.PASSWORD_MIN_LENGTH} أحرف.`, "VALIDATION_ERROR");
    }
    if (cleanEmail && ctx.db.get(`SELECT id FROM users WHERE lower(email)=? LIMIT 1`, [cleanEmail])) {
      throw appException(400, "البريد الإلكتروني مسجل بالفعل بمستخدم آخر.", "DUPLICATE_USER");
    }

    // `role` defaults to "cashier" (also when sent as null: normalize_role(None) -> cashier)
    const role = isBootstrap ? "admin" : normalizeRole(roleIn === undefined ? "cashier" : roleIn);
    const now = utcnowIso(ctx.now());
    const row = {
      id: uid(), name: cleanName, displayName: cleanName, email: cleanEmail || null, role,
      password: hashPassword(cleanPass), pin: null, isActive: 1,
      branch: (branchIn || "").trim() || null, createdAt: now, updatedAt: now,
    };
    insertRow(ctx.db, "users", row);
    return tokenResponse(row);
  }, { public: true });

  // get_current_user is declared on the route itself (the router is otherwise public).
  router.get("/auth/me", (ctx) => userPayload(ctx.user));

  router.post("/auth/logout", (ctx) => {
    const token = bearerToken(ctx.req);
    if (token) {
      const payload = decodeToken(token);
      if (payload && payload.jti) {
        const expIso = payload.exp ? new Date(payload.exp * 1000).toISOString() : utcnowIso(ctx.now());
        if (!ctx.db.get(`SELECT jti FROM revoked_tokens WHERE jti=?`, [payload.jti])) {
          ctx.db.run(`INSERT INTO revoked_tokens (jti, "expiresAt") VALUES (?,?)`, [payload.jti, expIso]);
        }
      }
    }
    return { success: true, message: "Logged out successfully" };
  }, { public: true });
}

/** Authentication / authorisation helpers and login throttling (port of core/auth.py). */
import type { SqlDriver } from "../db/types";
import { HttpError, unauthorized, forbidden } from "../http/errors";
import type { ApiRequest, AuthUser, Ctx } from "../http/types";
import { settings } from "./config";
import { decodeToken } from "./security";

export const VALID_ROLES = ["admin", "manager", "cashier", "user"] as const; // "user" is what the settings screen toggles to

/** The legacy AppException(status, message, code) body. */
export const appException = (status: number, message: string, error_code: string, details: Record<string, unknown> = {}) =>
  new HttpError(status, { error_code, message, details });

export function normalizeRole(role: string | null | undefined): string {
  const clean = (role || "cashier").trim().toLowerCase();
  return (VALID_ROLES as readonly string[]).includes(clean) ? clean : "cashier";
}

export function getUserPermissions(role: string | null | undefined): string[] {
  const clean = normalizeRole(role);
  if (clean === "admin") return ["admin.all"];
  if (clean === "manager") return ["pos.access", "inventory.manage", "reports.view", "expenses.view"];
  return ["pos.access"];
}

export function bearerToken(req: ApiRequest): string | null {
  const h = req.headers["authorization"];
  if (!h) return null;
  const m = /^\s*bearer\s+(.+)$/i.exec(h);
  return m && m[1]!.trim() ? m[1]!.trim() : null;
}

function resolveUser(token: string, db: SqlDriver): AuthUser {
  const payload = decodeToken(token);
  if (!payload || !payload.sub) throw unauthorized("Invalid or expired authentication token");
  if (payload.jti && db.get(`SELECT jti FROM revoked_tokens WHERE jti=?`, [payload.jti])) throw unauthorized("Session has been revoked");
  const user = db.get<any>(`SELECT * FROM users WHERE id=?`, [String(payload.sub)]);
  if (!user) throw unauthorized("User does not exist");
  if (!user.isActive) throw unauthorized("User account is inactive");
  return { ...user, permissions: getUserPermissions(user.role) } as AuthUser;
}

/** get_current_user: a valid, non-revoked token of an active user. */
export function authenticate(db: SqlDriver, req: ApiRequest): AuthUser {
  const token = bearerToken(req);
  if (!token) throw unauthorized("Authentication token required");
  return resolveUser(token, db);
}

/** get_optional_user: null instead of an error when the token is missing/invalid. */
export function optionalUser(db: SqlDriver, req: ApiRequest): AuthUser | null {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    return resolveUser(token, db);
  } catch (e) {
    if (e instanceof HttpError) return null;
    throw e;
  }
}

function requireRoles(ctx: Ctx, ...roles: string[]): AuthUser {
  if (!roles.includes(normalizeRole(ctx.user.role))) {
    throw appException(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء", "FORBIDDEN");
  }
  return ctx.user;
}
export const requireAdmin = (ctx: Ctx): AuthUser => requireRoles(ctx, "admin");
export const requireManager = (ctx: Ctx): AuthUser => requireRoles(ctx, "admin", "manager");

/** Permission code check with the admin wildcard. */
export function requirePermission(ctx: Ctx, permission: string): AuthUser {
  const perms = ctx.user.permissions ?? getUserPermissions(ctx.user.role);
  if (perms.includes(permission) || perms.includes("admin.all")) return ctx.user;
  throw forbidden(permission);
}

// ---------------------------------------------------------------------------
// Login throttling (in-memory, per identifier)
// ---------------------------------------------------------------------------
const attempts = new Map<string, [number, number]>(); // key -> [failures, lockedUntil (epoch seconds)]
const nowS = () => Date.now() / 1000;

export function clearThrottle(): void { attempts.clear(); }

export function throttleCheck(identifier: string): void {
  const [, lockedUntil] = attempts.get(identifier.toLowerCase()) ?? [0, 0];
  if (lockedUntil && lockedUntil > nowS()) {
    const wait = Math.floor(lockedUntil - nowS()) + 1;
    throw appException(429, `محاولات كثيرة خاطئة. حاول مرة أخرى بعد ${wait} ثانية.`, "TOO_MANY_ATTEMPTS");
  }
}

export function throttleFail(identifier: string): void {
  const key = identifier.toLowerCase();
  let [count, lockedUntil] = attempts.get(key) ?? [0, 0];
  if (lockedUntil && lockedUntil <= nowS()) count = 0;
  count += 1;
  lockedUntil = count >= settings.LOGIN_MAX_FAILURES ? nowS() + settings.LOGIN_LOCK_SECONDS : 0;
  attempts.set(key, [count, lockedUntil]);
}

export function throttleReset(identifier: string): void { attempts.delete(identifier.toLowerCase()); }

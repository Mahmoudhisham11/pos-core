/**
 * Cloud accounts. Every shop is its own tenant in Firebase (shops/{shopId}) and every account is a Firebase Auth user
 * whose membership is userShops/{uid} = { shopId, role, active, email, name, branch }.
 *
 * A device keeps ONE local database per shop; the database remembers which shop it belongs to (app_meta.shopId), so
 * the data of one shop can never be shown to, or synced into, another shop.
 *
 * Login on a device = the host proves the Firebase login (the ID token reads the account's own userShops doc from
 * Firestore, which only works for a genuine token of that uid), then the account is mirrored into the local users
 * table (role / active / bcrypt of the password) so the same e-mail and password also work offline on this device.
 */
import type { SqlDriver } from "../db/types";
import { settings } from "./config";

export interface CloudLink {
  uid: string;
  shopId: string;
  role: string;
  active: boolean;
  email: string;
  name: string;
  branch: string;
}

/** Proves an ID token and returns the account's shop membership. Injectable for tests. */
export type CloudVerifier = (idToken: string, uid: string) => Promise<CloudLink>;

/** Marks a request whose cloud login was verified by the host (a Symbol never survives IPC / postMessage / JSON). */
export const CLOUD_LINK = Symbol("nelly.cloudLink");

export class CloudAuthError extends Error {}

export function getMeta(db: SqlDriver, key: string): string | null {
  return db.get<{ value: string }>(`SELECT value FROM app_meta WHERE key=?`, [key])?.value ?? null;
}
export function setMeta(db: SqlDriver, key: string, value: string): void {
  db.run(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]);
}

/** The shop this database belongs to (null = not bound yet: a brand-new or legacy single-shop database). */
export const boundShop = (db: SqlDriver) => getMeta(db, "shopId");

function decodeJwtPayload(token: string): Record<string, any> {
  const part = token.split(".")[1];
  if (!part) throw new CloudAuthError("invalid token");
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const fieldValue = (f: any): any => {
  if (!f || typeof f !== "object") return undefined;
  if ("stringValue" in f) return f.stringValue;
  if ("booleanValue" in f) return f.booleanValue;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("doubleValue" in f) return f.doubleValue;
  if ("nullValue" in f) return null;
  return undefined;
};

/**
 * Default verifier: reads userShops/{uid} from Firestore WITH the caller's ID token. Firestore rules only let a
 * genuine token of that same uid read it, so a successful read proves the login; the project is pinned by settings.
 */
export const firestoreVerifier: CloudVerifier = async (idToken, uid) => {
  const project = settings.FIREBASE_PROJECT_ID;
  if (!project) throw new CloudAuthError("السحابة غير مُعدّة على هذا الجهاز.");
  const claims = decodeJwtPayload(idToken);
  if (claims.aud !== project || (claims.user_id || claims.sub) !== uid) throw new CloudAuthError("جلسة سحابية غير صالحة.");
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents/userShops/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 404) throw new CloudAuthError("الحساب غير مرتبط بأي محل.");
  if (!res.ok) throw new CloudAuthError("تعذر التحقق من الحساب السحابي.");
  const doc: any = await res.json();
  const f = doc.fields || {};
  const shopId = fieldValue(f.shopId);
  if (!shopId) throw new CloudAuthError("الحساب غير مرتبط بأي محل.");
  return {
    uid,
    shopId: String(shopId),
    role: String(fieldValue(f.role) || "admin"), // accounts provisioned before roles existed are shop owners
    active: fieldValue(f.active) !== false,
    email: String(fieldValue(f.email) || claims.email || "").toLowerCase(),
    name: String(fieldValue(f.name) || ""),
    branch: String(fieldValue(f.branch) || ""),
  };
};

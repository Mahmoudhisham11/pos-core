import { createBackend, configure, settings } from "../src/index";
import { openBetterSqlite } from "../src/node";

// settings are process-wide: every test starts from the core defaults, not from what an earlier test configured
const DEFAULTS = structuredClone(settings);

/** A fresh in-memory backend with a logged-in admin; `call` returns { status, body }. */
export async function setup(config: Parameters<typeof configure>[0] = {}) {
  configure({ ...structuredClone(DEFAULTS), SECRET_KEY: "test-secret", COLLECTION_PREFIX: "pos_", DEFAULT_BRAND: "", ...config });
  const db = openBetterSqlite(":memory:");
  const backend = createBackend(db);
  const reg = await backend.handle({ method: "POST", path: "/auth/register", body: { name: "admin", password: "1234" }, headers: {} });
  const token = (reg.body as any).access_token as string;
  const call = (method: string, path: string, body?: unknown) =>
    backend.handle({ method, path, body: body ?? null, headers: { authorization: `Bearer ${token}` } }) as Promise<{ status: number; body: any }>;
  return { backend, db, call };
}

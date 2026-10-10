import { clearThrottle } from "../src/core/auth";
import { configure } from "../src/core/config";
import { openBetterSqlite } from "../src/db/betterSqlite";
import { createBackend, type CloudLink } from "../src";

/** Fake cloud accounts for tests: idToken "tok:<uid>" proves <uid>. */
export const cloudAccounts = new Map<string, CloudLink>();

configure({ SECRET_KEY: "test-secret-key-for-vitest-only-0123456789abcdef" });

export interface CallOpts { token?: string; headers?: Record<string, string>; query?: Record<string, string | number | boolean> }

/** Fresh in-memory backend per call (the legacy `client` fixture): a clock that tests can move with setNow(). */
export function makeApp(start?: Date) {
  clearThrottle();
  const db = openBetterSqlite(":memory:");
  let fixed: Date | undefined = start; // real clock until a test pins one with setNow()
  const now = () => fixed ?? new Date();
  const backend = createBackend(db, {
    now,
    cloudVerify: async (idToken, uid) => {
      const link = cloudAccounts.get(uid);
      if (!link || idToken !== `tok:${uid}`) throw new Error("bad token");
      return link;
    },
  });

  async function call(method: string, path: string, body?: unknown, opts: CallOpts = {}) {
    let p = path;
    const query: Record<string, string> = {};
    const qi = p.indexOf("?");
    if (qi >= 0) {
      new URLSearchParams(p.slice(qi + 1)).forEach((v, k) => { query[k] = v; });
      p = p.slice(0, qi);
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) query[k] = String(v);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    // Round-trip through JSON like a real HTTP client so handlers never see undefined/Date values.
    const wire = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
    const res = await backend.handle({ method, path: p, query, body: wire, headers });
    return { status: res.status, body: res.body as any };
  }

  /** Bootstrap-registers the first (admin) account, like conftest.register_admin. */
  async function login(name = "Boss", email = "boss@example.com", password = "secret123"): Promise<string> {
    const res = await call("POST", "/api/auth/register", { name, email, password });
    if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
    return res.body.access_token as string;
  }

  /** Admin creates a cashier (conftest.cashier_headers) and returns its login token. */
  async function loginCashier(adminToken: string): Promise<string> {
    const created = await call("POST", "/api/users", { name: "Cashier One", email: "cash@example.com", password: "cash1234", role: "cashier" }, { token: adminToken });
    if (created.status !== 200) throw new Error(`create cashier failed: ${JSON.stringify(created.body)}`);
    const res = await call("POST", "/api/auth/login", { username: "cash@example.com", password: "cash1234" });
    if (res.status !== 200) throw new Error(`cashier login failed: ${JSON.stringify(res.body)}`);
    return res.body.access_token as string;
  }

  return {
    call, db, backend, login, loginCashier,
    setNow(d: Date) { fixed = d; },
    now,
  };
}
export type TestApp = ReturnType<typeof makeApp>;

/** Bootstrap-registers the first admin and returns its token (shared by the other test files). */
export const login = (app: TestApp, name?: string, email?: string, password?: string) => app.login(name, email, password);
export const loginCashier = (app: TestApp, adminToken: string) => app.loginCashier(adminToken);

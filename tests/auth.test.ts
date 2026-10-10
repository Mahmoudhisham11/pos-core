import { beforeEach, describe, expect, it } from "vitest";
import { isBcryptHash } from "../src/core/security";
import { cloudAccounts, login, loginCashier, makeApp, type TestApp } from "./helpers";

// Ported from tests_api/test_auth_security.py (+ conftest fixtures). The CORS test is a transport concern
// of the host shell (there is no HTTP layer in the core) and is not ported.
let app: TestApp;
beforeEach(() => { app = makeApp(); });

describe("auth security", () => {
  it("first register becomes admin, then registration closes", async () => {
    const token = await login(app);
    const me = (await app.call("GET", "/api/auth/me", undefined, { token })).body;
    expect(me.role).toBe("admin");
    expect("password" in me).toBe(false);
    expect("pin" in me).toBe(false);

    const again = await app.call("POST", "/api/auth/register", { name: "Eve", email: "eve@x.com", password: "pass1234", role: "admin" });
    expect(again.status).toBe(403);
    expect(again.body.error_code).toBe("REGISTRATION_CLOSED");
  });

  it("cloud login binds the database to the shop, mirrors the account and works offline afterwards", async () => {
    cloudAccounts.set("u1", { uid: "u1", shopId: "shop-u1", role: "admin", active: true, email: "owner@x.com", name: "Owner", branch: "فرع 1" });
    // a wrong / forged token is refused
    const bad = await app.call("POST", "/api/auth/cloud-login", { idToken: "tok:u2", uid: "u1", password: "pw1234" });
    expect(bad.status).toBe(401);
    expect(bad.body.error_code).toBe("CLOUD_AUTH_FAILED");

    const ok = await app.call("POST", "/api/auth/cloud-login", { idToken: "tok:u1", uid: "u1", password: "pw1234" });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ role: "admin", email: "owner@x.com" });
    expect((await app.call("GET", "/api/sync/bound-shop", undefined, { token: ok.body.access_token })).body.shopId).toBe("shop-u1");
    expect(app.db.get<any>(`SELECT * FROM users WHERE id='u1'`)).toMatchObject({ branch: "فرع 1", isActive: 1 });
    // same e-mail + password now also works locally (offline)
    expect((await app.call("POST", "/api/auth/login", { username: "owner@x.com", password: "pw1234" })).status).toBe(200);

    // an account of ANOTHER shop can never open this shop's database
    cloudAccounts.set("u9", { uid: "u9", shopId: "shop-u9", role: "admin", active: true, email: "other@x.com", name: "Other", branch: "" });
    const other = await app.call("POST", "/api/auth/cloud-login", { idToken: "tok:u9", uid: "u9", password: "pw1234" });
    expect(other.status).toBe(409);
    expect(other.body.error_code).toBe("WRONG_SHOP_DATABASE");
    expect(app.db.get(`SELECT id FROM users WHERE id='u9'`)).toBeUndefined();

    // sync calls that name another shop are refused too
    const t = ok.body.access_token;
    expect((await app.call("GET", "/api/sync/queue?shopId=shop-u9", undefined, { token: t })).status).toBe(409);
    expect((await app.call("POST", "/api/sync/apply-batch", { shopId: "shop-u9", items: [] }, { token: t })).status).toBe(409);
    expect((await app.call("POST", "/api/sync/apply-batch", { shopId: "shop-u1", items: [] }, { token: t })).status).toBe(200);
  });

  it("cloud role changes and deactivation reach the local copy at the next login", async () => {
    cloudAccounts.set("a1", { uid: "a1", shopId: "s1", role: "admin", active: true, email: "a@x.com", name: "A", branch: "" });
    cloudAccounts.set("c1", { uid: "c1", shopId: "s1", role: "cashier", active: true, email: "c@x.com", name: "C", branch: "" });
    await app.call("POST", "/api/auth/cloud-login", { idToken: "tok:a1", uid: "a1", password: "pw1234" });
    const c = await app.call("POST", "/api/auth/cloud-login", { idToken: "tok:c1", uid: "c1", password: "pw1234" });
    expect(c.body.user.role).toBe("cashier");
    cloudAccounts.set("c1", { ...cloudAccounts.get("c1")!, role: "manager" });
    expect((await app.call("POST", "/api/auth/cloud-login", { idToken: "tok:c1", uid: "c1", password: "pw1234" })).body.user.role).toBe("manager");
    cloudAccounts.set("c1", { ...cloudAccounts.get("c1")!, active: false });
    const off = await app.call("POST", "/api/auth/cloud-login", { idToken: "tok:c1", uid: "c1", password: "pw1234" });
    expect(off.status).toBe(401);
    expect(off.body.error_code).toBe("ACCOUNT_DISABLED");
    // ...and the offline login is closed as well
    expect((await app.call("POST", "/api/auth/login", { username: "c@x.com", password: "pw1234" })).status).toBe(401);
  });

  it("admin creates a user with role and branch from settings", async () => {
    const token = await login(app);
    const res = await app.call("POST", "/api/users", { name: "Mona", email: "mona@x.com", password: "pass1234", role: "cashier", branch: "الفرع الرئيسي" }, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: "cashier", branch: "الفرع الرئيسي", isActive: 1 });
    expect((await app.call("POST", "/api/auth/login", { username: "mona@x.com", password: "pass1234" })).status).toBe(200);
  });

  it("admin can register others and the role is applied", async () => {
    const token = await login(app);
    const ok = await app.call("POST", "/api/auth/register", { name: "Sam", email: "sam@x.com", password: "pass1234", role: "manager" }, { token });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe("manager");
  });

  it("endpoints require authentication", async () => {
    for (const path of ["/api/sales", "/api/shop/products", "/api/customers", "/api/users", "/api/sync/status", "/api/treasury/transactions"]) {
      expect((await app.call("GET", path)).status, path).toBe(401);
    }
    expect((await app.call("POST", "/api/sync/purge-tables", { confirm: "PURGE" })).status).toBe(401);
    expect((await app.call("GET", "/api/auth/me")).status).toBe(401); // no admin fallback any more
    expect((await app.call("GET", "/api/health")).status).toBe(200);
    expect((await app.call("GET", "/health")).status).toBe(200);
  });

  it("legacy forged token is rejected", async () => {
    const token = await login(app);
    const me = (await app.call("GET", "/api/auth/me", undefined, { token })).body;
    expect((await app.call("GET", "/api/auth/me", undefined, { token: `token_${me.id}_123` })).status).toBe(401);
  });

  it("a token signed with another secret is rejected", async () => {
    const token = await login(app);
    const [h, b] = token.split(".");
    expect((await app.call("GET", "/api/auth/me", undefined, { token: `${h}.${b}.AAAA` })).status).toBe(401);
  });

  it("passwords are hashed and plaintext never matches", async () => {
    const token = await login(app);
    await app.call("POST", "/api/users", { name: "Lina", email: "lina@x.com", password: "linapass", role: "cashier" }, { token });
    const stored = app.db.get<{ password: string }>(`SELECT password FROM users WHERE email='lina@x.com'`)!.password;
    expect(isBcryptHash(stored) && stored !== "linapass").toBe(true);

    // a legacy plaintext value in the DB must not authenticate
    app.db.run(`UPDATE users SET password='plain1234' WHERE email='lina@x.com'`);
    expect((await app.call("POST", "/api/auth/login", { username: "lina@x.com", password: "plain1234" })).status).toBe(401);
  });

  it("login uses exact match, not wildcards", async () => {
    await login(app);
    expect((await app.call("POST", "/api/auth/login", { username: "%", password: "secret123" })).status).toBe(401);
    expect((await app.call("POST", "/api/auth/login", { username: "boss@example.com", password: "secret123" })).status).toBe(200);
    expect((await app.call("POST", "/api/auth/login", { username: "BOSS@example.com", password: "secret123" })).status).toBe(200);
  });

  it("login throttling", async () => {
    await login(app);
    for (let i = 0; i < 5; i++) {
      expect((await app.call("POST", "/api/auth/login", { username: "boss@example.com", password: "bad" })).status).toBe(401);
    }
    const locked = await app.call("POST", "/api/auth/login", { username: "boss@example.com", password: "secret123" });
    expect(locked.status).toBe(429);
  });

  it("logout revokes the token", async () => {
    const token = await login(app);
    expect((await app.call("GET", "/api/auth/me", undefined, { token })).status).toBe(200);
    expect((await app.call("POST", "/api/auth/logout", undefined, { token })).status).toBe(200);
    expect((await app.call("GET", "/api/auth/me", undefined, { token })).status).toBe(401);
  });

  it("cashier cannot manage users or purge", async () => {
    const admin = await login(app);
    const cashier = await loginCashier(app, admin);
    expect((await app.call("POST", "/api/users", { name: "x", password: "12345" }, { token: cashier })).status).toBe(403);
    expect((await app.call("POST", "/api/sync/purge-tables", { confirm: "PURGE" }, { token: cashier })).status).toBe(403);
    expect((await app.call("DELETE", "/api/customers/abc", undefined, { token: cashier })).status).toBe(403);
  });

  it("purge requires confirmation", async () => {
    const token = await login(app);
    expect((await app.call("POST", "/api/sync/purge-tables", {}, { token })).status).toBe(400);
    const ok = await app.call("POST", "/api/sync/purge-tables", { confirm: "PURGE" }, { token });
    expect(ok.status).toBe(200);
    // users are kept by default so the admin is not locked out
    expect((await app.call("GET", "/api/auth/me", undefined, { token })).status).toBe(200);
  });

  it("cannot remove the last admin", async () => {
    const token = await login(app);
    const me = (await app.call("GET", "/api/auth/me", undefined, { token })).body;
    expect((await app.call("DELETE", `/api/users/${me.id}`, undefined, { token })).status).toBe(400);
    expect((await app.call("PUT", `/api/users/${me.id}`, { role: "cashier" }, { token })).status).toBe(400);
  });
});

describe("users / roles / branches / categories / sync", () => {
  it("user CRUD with duplicate email and validation", async () => {
    const token = await login(app);
    const dup = await app.call("POST", "/api/users", { name: "B", email: "BOSS@example.com", password: "abcd" }, { token });
    expect(dup.status).toBe(400);
    expect(dup.body.error_code).toBe("DUPLICATE_USER");
    const bad = await app.call("POST", "/api/users", { email: "z@x.com" }, { token });
    expect(bad.status).toBe(422);
    expect(bad.body.error_code).toBe("VALIDATION_ERROR");
    const badRole = await app.call("POST", "/api/users", { name: "Q", password: "abcd", role: "wizard" }, { token });
    expect(badRole.body.error_code).toBe("VALIDATION_ERROR");
    const created = (await app.call("POST", "/api/users", { name: " Zed ", password: "abcd", role: "manager" }, { token })).body;
    expect(created.name).toBe("Zed");
    expect(created.is_active).toBe(true);
    const upd = await app.call("PUT", `/api/users/${created.id}`, { isActive: false }, { token });
    expect(upd.body.isActive).toBe(0);
    expect((await app.call("GET", "/api/users/nope", undefined, { token })).body).toEqual({ detail: "المستخدم غير موجود" });
    expect((await app.call("DELETE", `/api/users/${created.id}`, undefined, { token })).body.success).toBe(true);
  });

  it("roles and branches are static", async () => {
    const token = await login(app);
    const roles = (await app.call("GET", "/api/roles", undefined, { token })).body;
    expect(roles.map((r: any) => r.id)).toEqual(["role-admin", "role-manager", "role-cashier"]);
    expect(roles[0].permissions).toEqual(["admin.all"]);
    const branches = (await app.call("GET", "/api/branches", undefined, { token })).body;
    expect(branches[0].locations).toHaveLength(2);
  });

  it("categories merge defaults, stored and product categories", async () => {
    const token = await login(app);
    expect((await app.call("POST", "/api/categories", { name: " " }, { token })).body.error_code).toBe("VALIDATION_ERROR");
    await app.call("POST", "/api/categories", { name: "شنط", description: "d" }, { token });
    await app.call("POST", "/api/categories", { name: "شنط" }, { token }); // idempotent
    const list = (await app.call("GET", "/api/categories", undefined, { token })).body;
    expect(list.map((c: any) => c.name)).toEqual(["ميكاب", "عناية بالبشرة", "عناية بالشعر", "عطور", "إكسسوارات", "أخرى", "شنط"]);
    expect(list[6]).toEqual({ id: "cat-7", name: "شنط", description: "d" });
  });

  it("sync apply respects local pending edits, newer local copies, deletes and echo suppression", async () => {
    const token = await login(app);
    const apply = (body: unknown) => app.call("POST", "/api/sync/apply", body, { token });
    const r1 = await apply({ collectionName: "nelly_customers", docId: "c1", data: { name: "Remote", balance: "5", updatedAt: "2024-01-01T00:00:00+00:00" } });
    expect(r1.body).toMatchObject({ success: true, appliedCount: 1, action: "SET", id: "c1" });
    // remote changes are not echoed to the outbox
    expect((await app.call("GET", "/api/sync/queue", undefined, { token })).body).toEqual([]);
    expect(app.db.get<any>(`SELECT * FROM customers WHERE id='c1'`)).toMatchObject({ name: "Remote", balance: 5, type: "قطاعي" });

    // older snapshot is skipped...
    await apply({ collectionName: "nelly_employees", docId: "e1", data: { name: "Emp", updatedAt: "2024-01-01T00:00:00+00:00" } });
    const r2 = await apply({ collectionName: "nelly_employees", docId: "e1", data: { name: "Old", updatedAt: "2023-01-01T00:00:00+00:00" } });
    expect(r2.body.skippedCount).toBe(1);
    // ...except for counter tables (stock, balances): the cloud doc is the sum of all devices' increments
    const r2b = await apply({ collectionName: "nelly_customers", docId: "c1", data: { name: "Remote", balance: 7, updatedAt: "2023-01-01T00:00:00+00:00" } });
    expect(r2b.body.appliedCount).toBe(1);
    expect(app.db.get<any>(`SELECT balance FROM customers WHERE id='c1'`).balance).toBe(7);

    // a local edit that is still in the outbox wins
    app.db.run(`INSERT INTO sync_queue (tableName,recordId,action,payload,status,createdAt) VALUES ('customers','c1','UPDATE','{}','pending','x')`);
    expect((await apply({ collectionName: "nelly_customers", docId: "c1", data: { name: "Cloud" } })).body.skippedCount).toBe(1);

    expect((await apply({ collectionName: "nope", docId: "x" })).body.error_code).toBe("VALIDATION_ERROR");
    expect((await apply({ collectionName: "nelly_customers", docId: "c1", action: "DELETE" })).body.action).toBe("DELETED");
    // delete is blocked while pending, so the row is still there
    expect(app.db.get(`SELECT id FROM customers WHERE id='c1'`)).toBeDefined();

    const q = (await app.call("GET", "/api/sync/queue", undefined, { token })).body;
    expect(q[0]).toMatchObject({ tableName: "customers", collectionName: "nelly_customers", payload: {} });
    expect((await app.call("POST", "/api/sync/queue/mark-synced", { ids: [q[0].id] }, { token })).body).toEqual({ success: true, removedCount: 1 });
    expect((await app.call("GET", "/api/sync/queue?limit=0", undefined, { token })).status).toBe(422);
    expect((await app.call("GET", "/api/sync/status", undefined, { token })).body.lastSynced).toHaveProperty("nelly_customers");
  });

  it("apply-batch isolates a failing document and re-hashes cloud passwords", async () => {
    const token = await login(app);
    const res = await app.call("POST", "/api/sync/apply-batch", {
      items: [
        { collectionName: "nelly_customers", docId: "ok1", data: { name: "A" } },
        { collectionName: "nelly_customers", docId: "bad" }, // name is NOT NULL without default -> fails alone
        { collectionName: "nelly_users", docId: "u9", data: { email: "u9@x.com", password: "plain99", pin: "1234" } },
      ],
    }, { token });
    expect(res.body).toMatchObject({ success: false, appliedCount: 2, failedCount: 1 });
    expect(res.body.failed[0].docId).toBe("bad");
    const u = app.db.get<any>(`SELECT * FROM users WHERE id='u9'`);
    expect(isBcryptHash(u.password)).toBe(true);
    expect(u.pin).toBeNull();
    expect(u.isActive).toBe(1);
    expect((await app.call("POST", "/api/auth/login", { username: "u9@x.com", password: "plain99" })).status).toBe(200);
  });

  it("migrations hash legacy plaintext passwords and clear pins", () => {
    const old = makeApp();
    old.db.run(`INSERT INTO users (id,email,role,password,pin,"isActive") VALUES ('p1','p@x.com','cashier','plain','1111',1)`);
    old.db.run(`UPDATE schema_version SET version=1`);
    // re-open the same database through a new backend: v2 must run
    return import("../src").then(({ createBackend }) => {
      createBackend(old.db);
      const u = old.db.get<any>(`SELECT * FROM users WHERE id='p1'`);
      expect(isBcryptHash(u.password)).toBe(true);
      expect(u.pin).toBeNull();
    });
  });
});

import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers";

describe("inline query strings", () => {
  it("the UI sends '/customers?limit=1&search=a' as one path: the backend must split it like an HTTP server", async () => {
    const app = makeApp();
    const tok = await app.login();
    const A = { token: tok };
    await app.call("POST", "/api/customers", { name: "Mona" }, A);
    await app.call("POST", "/api/customers", { name: "Zaki" }, A);
    const res = await app.backend.handle({ method: "GET", path: "/customers?search=mon&limit=5", query: {}, body: null, headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    expect((res.body as any[]).map((c) => c.name)).toEqual(["Mona"]);
  });
});

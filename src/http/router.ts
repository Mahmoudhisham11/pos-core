import type { SqlDriver } from "../db/types";
import { HttpError } from "./errors";
import type { ApiRequest, ApiResponse, AuthUser, Ctx, Handler, RouteOpts } from "./types";

const RESPONSE = Symbol("nelly.response");
/** Return from a handler to send a status other than 200 (e.g. 201 / 204). */
export const respond = (status: number, body: any) => ({ [RESPONSE]: true, status, body });

interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; opts: RouteOpts }

export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler, opts: RouteOpts = {}) {
    const keys: string[] = [];
    const src = pattern.replace(/\{([a-zA-Z_]+)(?::path)?\}/g, (m, k) => { keys.push(k); return m.includes(":path") ? "(.+)" : "([^/]+)"; });
    this.routes.push({ method: method.toUpperCase(), re: new RegExp(`^${src}/?$`), keys, handler, opts });
  }
  get = (p: string, h: Handler, o?: RouteOpts) => this.add("GET", p, h, o);
  post = (p: string, h: Handler, o?: RouteOpts) => this.add("POST", p, h, { write: true, ...o });
  put = (p: string, h: Handler, o?: RouteOpts) => this.add("PUT", p, h, { write: true, ...o });
  patch = (p: string, h: Handler, o?: RouteOpts) => this.add("PATCH", p, h, { write: true, ...o });
  delete = (p: string, h: Handler, o?: RouteOpts) => this.add("DELETE", p, h, { write: true, ...o });

  /** Static routes must be registered before parametrised ones that could shadow them (same as FastAPI order). */
  async dispatch(
    db: SqlDriver,
    req: ApiRequest,
    deps: { authenticate: (db: SqlDriver, req: ApiRequest) => AuthUser; now: () => Date },
  ): Promise<ApiResponse> {
    try {
      const method = req.method.toUpperCase();
      let pathMatched = false;
      for (const r of this.routes) {
        const m = r.re.exec(req.path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
        const run = (): ApiResponse => {
          const user = r.opts.public ? ({} as AuthUser) : deps.authenticate(db, req);
          const ctx: Ctx = { db, req, params, query: req.query, body: req.body ?? {}, user, now: deps.now };
          const out = r.handler(ctx);
          if (out && out[RESPONSE]) return { status: out.status, body: out.body };
          return { status: 200, body: out === undefined ? null : out };
        };
        // Writers are serialised by the single synchronous driver; the transaction rolls back on any throw.
        return r.opts.write ? db.transaction(run) : run();
      }
      if (pathMatched) return { status: 405, body: { detail: "Method Not Allowed" } };
      return { status: 404, body: { detail: "Not Found" } };
    } catch (e) {
      // AppException -> the dict itself (legacy exception handler); plain HTTPException -> {detail}.
      if (e instanceof HttpError) {
        const d = e.detail;
        return { status: e.status, body: d && typeof d === "object" ? d : { detail: d } };
      }
      console.error(e);
      return { status: 500, body: { error_code: "INTERNAL_SERVER_ERROR", message: "An internal server error occurred.", detail: e instanceof Error ? e.message : String(e) } };
    }
  }
}

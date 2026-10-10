import type { Ctx } from "../http/types";
import { nowIso } from "../db/sql";

const key = (ctx: Ctx): string | null => {
  const raw = ctx.req.headers["idempotency-key"];
  return raw && raw.trim() ? raw.trim().slice(0, 100) : null;
};

/** Stored response of an earlier request with the same Idempotency-Key, if any. Call BEFORE doing work. */
export function lookup(ctx: Ctx): any | undefined {
  const k = key(ctx);
  if (!k) return undefined;
  const rec = ctx.db.get<{ response: string }>(`SELECT response FROM idempotency_keys WHERE key=?`, [k]);
  return rec ? JSON.parse(rec.response) : undefined;
}

/** Store the response in the same transaction as the side effects; returns `result` for convenience. */
export function recordResult<T>(ctx: Ctx, result: T): T {
  const k = key(ctx);
  if (k) {
    ctx.db.run(`INSERT OR IGNORE INTO idempotency_keys (key,endpoint,response,createdAt) VALUES (?,?,?,?)`,
      [k, ctx.req.path.slice(0, 100), JSON.stringify(result), nowIso()]);
  }
  return result;
}

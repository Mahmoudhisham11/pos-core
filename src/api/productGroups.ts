import { requireManager } from "../core/auth";
import { addVariants, createGroup, deleteGroup, getGroup, listGroups, parseGroupIn, updateGroup } from "../domain/variants";
import type { ProductTable } from "../domain/stock";
import { respond, type Router } from "../http/router";
import type { Ctx } from "../http/types";
import { parseLimit } from "./stockCommon";

/**
 * Product models with variants (size / colour ...) under `prefix`:
 *   GET    {prefix}                      models with their variants (?search=&category=&includeSingles=1&limit=)
 *   POST   {prefix}                      create a model + its variants
 *   GET    {prefix}/{group_id}           one model
 *   PUT    {prefix}/{group_id}           shared fields (name, category, brand, description, minThreshold, prices+applyToAll)
 *   POST   {prefix}/{group_id}/variants  add variants
 *   DELETE {prefix}/{group_id}           delete the model and all its variants (manager)
 */
export function registerProductGroups(router: Router, prefix: string, table: ProductTable, defaultThreshold: number): void {
  router.get(prefix, (ctx) => listGroups(ctx.db, table, {
    search: ctx.query.search,
    category: ctx.query.category,
    includeSingles: ["1", "true", "yes"].includes(String(ctx.query.includeSingles ?? "").toLowerCase()),
    limit: parseLimit(ctx),
  }));

  router.post(prefix, (ctx) =>
    respond(201, createGroup(ctx.db, table, parseGroupIn(ctx.body), defaultThreshold, ctx.now().toISOString())));

  router.get(`${prefix}/{group_id}`, (ctx) => getGroup(ctx.db, table, ctx.params.group_id!));

  const update = (ctx: Ctx) => updateGroup(ctx.db, table, ctx.params.group_id!, ctx.body, ctx.now().toISOString());
  router.put(`${prefix}/{group_id}`, update);
  router.patch(`${prefix}/{group_id}`, update);

  router.post(`${prefix}/{group_id}/variants`, (ctx) =>
    addVariants(ctx.db, table, ctx.params.group_id!, ctx.body, ctx.now().toISOString()));

  router.delete(`${prefix}/{group_id}`, (ctx) => {
    requireManager(ctx);
    const count = deleteGroup(ctx.db, table, ctx.params.group_id!, ctx.now().toISOString());
    return { success: true, deletedVariants: count, message: "تم حذف الموديل بكل اختياراته" };
  });
}

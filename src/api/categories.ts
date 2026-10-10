import { insertRow, uid } from "../db/sql";
import { appException } from "../core/auth";
import { utcnowIso } from "../core/timeutil";
import type { Router } from "../http/router";

const DEFAULT_CATEGORIES = ["ميكاب", "عناية بالبشرة", "عناية بالشعر", "عطور", "إكسسوارات", "أخرى"];

export function registerCategories(router: Router): void {
  router.get("/categories", (ctx) => {
    const stored = ctx.db.all<any>(`SELECT * FROM categories ORDER BY name ASC`);
    const distinct = (table: string) =>
      ctx.db.all<{ category: string | null }>(`SELECT DISTINCT category FROM ${table}`).map((r) => r.category).filter((c): c is string => !!c);
    const descriptions = new Map<string, string>(stored.map((c) => [c.name, c.description || ""]));
    const names = [...new Set([...DEFAULT_CATEGORIES, ...stored.map((c) => c.name as string), ...distinct("shop_products"), ...distinct("products")])];
    return names.map((n, idx) => ({ id: `cat-${idx + 1}`, name: n, description: descriptions.get(n) ?? "" }));
  });

  router.post("/categories", (ctx) => {
    const data = ctx.body ?? {};
    const name = String(data.name || "").trim();
    if (!name) throw appException(400, "اسم القسم مطلوب", "VALIDATION_ERROR");
    let existing = ctx.db.get<any>(`SELECT * FROM categories WHERE lower(name)=? LIMIT 1`, [name.toLowerCase()]);
    if (!existing && !DEFAULT_CATEGORIES.includes(name)) {
      existing = { id: uid(), name, description: String(data.description || ""), createdAt: utcnowIso(ctx.now()) };
      insertRow(ctx.db, "categories", existing);
    }
    return { id: `cat-${name}`, name: existing ? existing.name : name, description: (existing ? existing.description : "") || "" };
  });
}

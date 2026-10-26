import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

const polo = {
  name: "تيشيرت بولو",
  category: "تيشيرتات",
  costPrice: 150,
  sellingPrice: 300,
  options: [
    { name: "اللون", values: ["أسود", "أبيض"] },
    { name: "المقاس", values: ["M", "L", "XL"] },
  ],
};

describe("product groups (variants)", () => {
  it("creates every combination of the options", async () => {
    const { call } = await setup();
    const r = await call("POST", "/shop/product-groups", polo);
    expect(r.status).toBe(201);
    expect(r.body.variantsCount).toBe(6);
    expect(r.body.options).toEqual(polo.options);
    const names = r.body.variants.map((v: any) => v.name);
    expect(names).toContain("تيشيرت بولو - أسود / L");
    expect(r.body.variants.every((v: any) => v.sellingPrice === 300 && v.costPrice === 150 && v.quantity === 0)).toBe(true);
    expect(r.body.variants[0].attributes).toEqual({ "اللون": "أسود", "المقاس": "M" });
  });

  it("creates only the listed variants with their own barcode, quantity and price", async () => {
    const { call } = await setup();
    const r = await call("POST", "/shop/product-groups", {
      ...polo,
      variants: [
        { attributes: { "اللون": "أسود", "المقاس": "L" }, barcode: "100200", quantity: 5 },
        { attributes: { "المقاس": "XL", "اللون": "أبيض" }, quantity: 2, sellingPrice: 320 },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.variantsCount).toBe(2);
    expect(r.body.totalQuantity).toBe(7);
    expect(r.body.minPrice).toBe(300);
    expect(r.body.maxPrice).toBe(320);
    // label follows the option order, not the key order the client sent
    expect(r.body.variants[1].variantLabel).toBe("أبيض / XL");
  });

  it("refuses duplicate barcodes and duplicate combinations", async () => {
    const { call } = await setup();
    await call("POST", "/shop/products", { name: "صنف قديم", barcode: "555" });
    const dupBarcode = await call("POST", "/shop/product-groups", { ...polo, variants: [{ attributes: { "اللون": "أسود", "المقاس": "M" }, barcode: "555" }] });
    expect(dupBarcode.status).toBe(409);
    expect(dupBarcode.body.error_code).toBe("DUPLICATE_BARCODE");
    const dupCombo = await call("POST", "/shop/product-groups", {
      ...polo,
      variants: [{ attributes: { "اللون": "أسود", "المقاس": "M" } }, { attributes: { "المقاس": "M", "اللون": "أسود" } }],
    });
    expect(dupCombo.status).toBe(409);
    expect(dupCombo.body.error_code).toBe("DUPLICATE_VARIANT");
    const badKey = await call("POST", "/shop/product-groups", { ...polo, variants: [{ attributes: { "الخامة": "قطن" } }] });
    expect(badKey.status).toBe(400);
    // nothing was half-created
    const list = await call("GET", "/shop/product-groups");
    expect(list.body).toHaveLength(0);
  });

  it("sells, returns and restocks a single variant only", async () => {
    const { call } = await setup();
    const g = (await call("POST", "/shop/product-groups", {
      ...polo, options: undefined,
      variants: [
        { attributes: { "اللون": "أسود", "المقاس": "L" }, barcode: "B-L", quantity: 5 },
        { attributes: { "اللون": "أسود", "المقاس": "XL" }, barcode: "B-XL", quantity: 3 },
      ],
    })).body;
    const sale = await call("POST", "/sales", { items: [{ barcode: "B-L", quantity: 2 }], paidAmount: 600 });
    expect(sale.status).toBe(200);
    const line = sale.body.items[0];
    expect(line.name).toBe("تيشيرت بولو - أسود / L");
    expect(line.groupId).toBe(g.groupId);
    expect(line.variantLabel).toBe("أسود / L");
    expect(line.attributes).toEqual({ "اللون": "أسود", "المقاس": "L" });

    let group = (await call("GET", `/shop/product-groups/${g.groupId}`)).body;
    expect(group.variants.map((v: any) => v.quantity)).toEqual([3, 3]);

    const ret = await call("POST", "/returns", { invoiceId: sale.body.id, returnedItems: [{ barcode: "B-L", quantity: 1 }] });
    expect(ret.status).toBe(200);
    group = (await call("GET", `/shop/product-groups/${g.groupId}`)).body;
    expect(group.variants.map((v: any) => v.quantity)).toEqual([4, 3]);
    expect(group.totalQuantity).toBe(7);

    const pur = await call("POST", "/shop/purchases", { items: [{ barcode: "B-XL", quantity: 10, costPrice: 120 }], paidAmount: 1200 });
    expect(pur.status).toBe(200);
    group = (await call("GET", `/shop/product-groups/${g.groupId}`)).body;
    expect(group.variants[1].quantity).toBe(13);
    expect(pur.body.items[0].variantLabel).toBe("أسود / XL");
  });

  it("adds a brand-new variant to a model through a purchase line", async () => {
    const { call } = await setup();
    const g = (await call("POST", "/shop/product-groups", { ...polo, options: undefined, variants: [{ attributes: { "اللون": "أسود", "المقاس": "L" } }] })).body;
    const pur = await call("POST", "/shop/purchases", {
      items: [{ barcode: "NEW-1", quantity: 4, costPrice: 140, groupId: g.groupId, groupName: g.name, attributes: { "اللون": "أحمر", "المقاس": "L" } }],
      paidAmount: 560,
    });
    expect(pur.status).toBe(200);
    const group = (await call("GET", `/shop/product-groups/${g.groupId}`)).body;
    expect(group.variantsCount).toBe(2);
    expect(group.variants[1].name).toBe("تيشيرت بولو - أحمر / L");
    expect(group.variants[1].quantity).toBe(4);
  });

  it("transfers a variant from the warehouse and keeps it in its group", async () => {
    const { call } = await setup();
    const wh = (await call("POST", "/product-groups", { ...polo, options: undefined, variants: [{ attributes: { "اللون": "أسود", "المقاس": "M" }, barcode: "W-M", quantity: 10 }] })).body;
    const t = await call("POST", "/shop/transfers", { barcode: "W-M", quantity: 4, direction: "to_shop" });
    expect(t.status).toBe(200);
    const shop = (await call("GET", `/shop/product-groups/${wh.groupId}`)).body;
    expect(shop.variants[0].quantity).toBe(4);
    expect(shop.variants[0].variantLabel).toBe("أسود / M");
    expect((await call("GET", `/product-groups/${wh.groupId}`)).body.variants[0].quantity).toBe(6);
  });

  it("updates shared fields, renames every variant and guards prices", async () => {
    const { call } = await setup();
    const g = (await call("POST", "/shop/product-groups", polo)).body;
    const noFlag = await call("PUT", `/shop/product-groups/${g.groupId}`, { sellingPrice: 350 });
    expect(noFlag.status).toBe(400);
    expect(noFlag.body.error_code).toBe("APPLY_TO_ALL_REQUIRED");
    const r = await call("PUT", `/shop/product-groups/${g.groupId}`, { name: "بولو قطن", category: "صيفي", sellingPrice: 350, applyToAll: true });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("بولو قطن");
    expect(r.body.variants.every((v: any) => v.name.startsWith("بولو قطن - ") && v.category === "صيفي" && v.sellingPrice === 350)).toBe(true);
  });

  it("adds the missing combinations, edits one variant and deletes the model", async () => {
    const { call } = await setup();
    const g = (await call("POST", "/shop/product-groups", { ...polo, options: [{ name: "المقاس", values: ["M", "L"] }] })).body;
    const added = await call("POST", `/shop/product-groups/${g.groupId}/variants`, { options: [{ name: "المقاس", values: ["M", "L", "XL", "XXL"] }] });
    expect(added.status).toBe(200);
    expect(added.body.variants.map((v: any) => v.variantLabel)).toEqual(["M", "L", "XL", "XXL"]);

    const xxl = added.body.variants[3];
    const clash = await call("PUT", `/shop/products/${xxl.id}`, { attributes: { "المقاس": "M" } });
    expect(clash.status).toBe(409);
    const edited = await call("PUT", `/shop/products/${xxl.id}`, { attributes: { "المقاس": "3XL" }, sellingPrice: 330 });
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe("تيشيرت بولو - 3XL");
    expect(edited.body.sellingPrice).toBe(330);

    const byGroup = await call("GET", `/shop/products?groupId=${g.groupId}`);
    expect(byGroup.body).toHaveLength(4);

    const del = await call("DELETE", `/shop/product-groups/${g.groupId}`);
    expect(del.body.deletedVariants).toBe(4);
    expect((await call("GET", `/shop/product-groups/${g.groupId}`)).status).toBe(404);
  });

  it("lists models, optionally with the products that have no variants, and searches inside variants", async () => {
    const { call } = await setup();
    await call("POST", "/shop/product-groups", polo);
    await call("POST", "/shop/products", { name: "حزام جلد", barcode: "BELT" });
    expect((await call("GET", "/shop/product-groups")).body).toHaveLength(1);
    const all = (await call("GET", "/shop/product-groups?includeSingles=1")).body;
    expect(all).toHaveLength(2);
    const belt = all.find((x: any) => !x.isVariantGroup);
    expect(belt.productId).toBeTruthy();
    const found = (await call("GET", "/shop/product-groups?search=XL")).body;
    expect(found).toHaveLength(1);
    expect(found[0].variantsCount).toBe(6); // the whole model comes back, not only the matching variant
  });

  it("queues every variant for cloud sync with its variant columns", async () => {
    const { call } = await setup();
    await call("POST", "/shop/product-groups", { ...polo, options: [{ name: "المقاس", values: ["M"] }] });
    const q = (await call("GET", "/sync/queue")).body;
    const prod = q.find((x: any) => x.tableName === "shop_products");
    expect(prod.collectionName).toBe("pos_shop_products");
    expect(prod.payload.groupName).toBe("تيشيرت بولو");
    expect(prod.payload.attributes).toEqual({ "المقاس": "M" });
  });

  it("applies a variant coming from another device", async () => {
    const { call, db } = await setup();
    const r = await call("POST", "/sync/apply-batch", {
      items: [{
        collectionName: "pos_shop_products", docId: "remote-1", action: "SET",
        data: { id: "remote-1", name: "جاكيت - أزرق / L", quantity: 2, groupId: "g-remote", groupName: "جاكيت", variantLabel: "أزرق / L", attributes: "{\"اللون\":\"أزرق\",\"المقاس\":\"L\"}" },
      }],
    });
    expect(r.body.appliedCount).toBe(1);
    const row = db.get<any>(`SELECT * FROM shop_products WHERE id='remote-1'`);
    expect(row.groupId).toBe("g-remote");
    expect((await call("GET", "/shop/product-groups/g-remote")).body.options).toEqual([{ name: "اللون", values: ["أزرق"] }, { name: "المقاس", values: ["L"] }]);
  });
});

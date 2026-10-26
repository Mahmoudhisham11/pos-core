import { settings } from "../core/config";
import { cashMethod } from "../core/payments";
import { collectionTableMap } from "../core/syncHooks";
import { DELTA_FIELDS, PUSHED_TABLES } from "../db/sql";
import type { Router } from "../http/router";

export const CORE_VERSION = "0.2.0";

/**
 * The cloud collections this app syncs, with the local table behind each one:
 *  - pushed: local changes are uploaded (users are only pulled)
 *  - counter: UPDATEs carry `__deltas` that must be applied as Firestore increments (stock, balances)
 */
export function syncCollections() {
  return Object.entries(collectionTableMap()).map(([name, table]) => ({
    name,
    table,
    pushed: PUSHED_TABLES.has(table),
    counter: table in DELTA_FIELDS,
    counterFields: DELTA_FIELDS[table] ?? [],
  }));
}

/** Public description of this backend, so a new frontend can discover what it offers before logging in. */
export function registerMeta(router: Router): void {
  router.get("/app-info", () => ({
    app: settings.APP_NAME,
    core: "@devora/pos-core",
    coreVersion: CORE_VERSION,
    api: settings.API_V1_STR,
    features: { variants: true, warehouse: true, cloudSync: true, shifts: true, employees: true, treasury: true },
    defaults: {
      brand: settings.DEFAULT_BRAND, category: settings.DEFAULT_CATEGORY,
      customerName: settings.DEFAULT_CUSTOMER_NAME, customerType: settings.DEFAULT_CUSTOMER_TYPE, paymentMethod: cashMethod(),
    },
    currency: { code: settings.CURRENCY, symbol: settings.CURRENCY_SYMBOL },
    paymentMethods: settings.PAYMENT_METHODS.map((m) => ({ name: m.name, channel: m.channel, credit: !!m.credit })),
    collections: syncCollections(),
  }), { public: true });
}

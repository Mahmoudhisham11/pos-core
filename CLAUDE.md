# Project notes for Claude Code

- This repo is `@devora/pos-core`: a **brand-neutral** POS backend used by several apps (Nelly = makeup shops,
  more coming, e.g. clothing). Apps install it from GitHub by tag (`github:Mahmoudhisham11/pos-core#vX.Y.Z`).
  Never hard-code an app/brand name here; anything app-specific goes in `settings` (`src/core/config.ts`) and each
  app sets it with `configure()`.
- Public API = `src/index.ts` (`@devora/pos-core`) and `src/node.ts` (`@devora/pos-core/node`, better-sqlite3 only),
  locked by `exports` in package.json. Anything an app needs must be exported from there, never imported from `src/...`.
- Payment methods, currency and default customer come from `settings` via `src/core/payments.ts`: never write
  "نقدي" / "آجل" / "EGP" in the code. Cloud collection names come from `COLLECTION_PREFIX` (`GET /app-info`).
- Variants (size / colour ...): every variant is a full product row; variants of a model share `groupId`
  (`groupName`, `variantLabel`, `attributes`). Logic in `src/domain/variants.ts`, routes in `src/api/productGroups.ts`.
- Schema changes: add the column to the DDL **and** `TABLE_COLUMNS` in `src/db/schema.ts`, and a new numbered step in
  `src/db/migrations.ts` (existing databases are only upgraded by migrations). Writes to synced tables must go through
  `insertRow` / `updateRow` / `deleteRow` (they fill the sync outbox).
- Releasing: bump `version` in package.json **and** `CORE_VERSION` in `src/api/meta.ts`, commit, tag `vX.Y.Z`, push
  with tags; apps then move their dependency to the new tag.
- Checks: `npm run typecheck` and `npm test` (vitest, `test/`).

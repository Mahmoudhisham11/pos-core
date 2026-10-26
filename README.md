# POS Core (`@devora/pos-core`)

باك إند عام لأي نظام كاشير (محل مكياج، ملابس، صيدلية، سوبر ماركت...). مش مربوط بأي براند: كل حاجة خاصة بالتطبيق (الاسم، أسماء الـ collections، العملة، طرق الدفع...) بتيجي من الواجهة في `configure()`.

بيشمل: الأصناف والـ variants، البيع والمرتجعات، المشتريات، المخزن والمحل والتحويل بينهم، سجل حركة المخزون، الشيفتات، العملاء والموردين والآجل، الموظفين، المصروفات، الخزنة، والمزامنة مع السحابة.

## التثبيت في مشروع

في `package.json` بتاع الواجهة، ثبّت على نسخة معيّنة (tag):

```json
"dependencies": {
  "@devora/pos-core": "github:Mahmoudhisham11/pos-core#v0.2.0"
}
```

- لو عايز تحدّث المشروع لنسخة أحدث، غيّر رقم الـ tag واعمل `npm install`.
- الكود TypeScript من غير build: Next.js محتاج `transpilePackages: ["@devora/pos-core"]`، وesbuild بيقراه على طول.
- `better-sqlite3` (لـ Node/Electron) بيتثبت مع المكتبة. في المتصفح استخدم `wrapWasmSqlite` مع `@sqlite.org/sqlite-wasm`.

### تعديل الـ core وتجربته مع مشروع في نفس الوقت

```bash
cd pos-core && npm link
cd ../<المشروع> && npm link @devora/pos-core
```

ولما تخلص: اعمل commit وtag جديد هنا (`npm version minor` ثم `git push --follow-tags`)، وبعدين غيّر الـ tag في المشروع.

## الأوامر

```bash
npm install
npm run typecheck
npm test
```

---

## 1) ربط واجهة جديدة بالباك إند

```js
import { createBackend, configure } from "@devora/pos-core";
import { openBetterSqlite } from "@devora/pos-core/node"; // Node/Electron بس (المتصفح يستخدم wrapWasmSqlite)

configure({
  APP_NAME: "Fashion POS",          // يظهر في GET / و /health
  COLLECTION_PREFIX: "fashion_",    // أسماء collections في Firestore: fashion_sales, fashion_shop_products ...
  DEFAULT_BRAND: "",                // البراند الافتراضي للصنف الجديد لو ما اتبعتش
  BRANCH_NAME: "الفرع الرئيسي",
  SHOP_LOCATION_NAME: "المعرض",
  WAREHOUSE_LOCATION_NAME: "المخزن الرئيسي",
  SECRET_KEY: "...",                // من الـ host
  FIREBASE_PROJECT_ID: "...",       // اختياري: لتسجيل الدخول السحابي
  CURRENCY: "EGP", CURRENCY_SYMBOL: "ج.م",
  PAYMENT_METHODS: [                // شوف الجزء "الفلوس وطرق الدفع" تحت
    { name: "نقدي", channel: "cash", aliases: ["cash", "كاش"] },
    { name: "فيزا", channel: "visa", matchPrefix: true },
    { name: "فودافون كاش", channel: "wallets" },
    { name: "آجل", channel: "cash", credit: true },
  ],
  DEFAULT_CUSTOMER_NAME: "عميل نقدي",
  DEFAULT_CUSTOMER_TYPE: "قطاعي",
});
const backend = createBackend(db);  // db = better-sqlite3 أو SQLite WASM
```

- **الاستيراد من الـ core بيكون من مدخلين بس**: `@devora/pos-core` (كل حاجة) و`@devora/pos-core/node` (`openBetterSqlite`). أي استيراد لملف داخلي زي `@devora/pos-core/src/...` ممنوع (الـ `exports` في `package.json` بتقفله)، عشان ترتيب الملفات جوه الـ core يتغير من غير ما أي واجهة تبوظ.
- `GET /app-info` بيرجّع اسم التطبيق والمميزات المتاحة (`features.variants`)، وقائمة الـ collections اللي محتاج تزامنها مع اسم الجدول بتاع كل واحدة، وهل هي counter (بتتزامن كـ increments) ولا لأ. يعني الواجهة الجديدة **مش محتاجة تكتب أسماء الـ collections بإيدها**.
- مثال: Nelly بتبعت إعداداتها من `Frontend/core.config.json` (`COLLECTION_PREFIX: "nelly_"`).
- محرك المزامنة في الواجهة لازم يقرا قائمة الـ collections والـ counters من `GET /app-info` (زي `lib/syncManager.js` في Nelly)، وما يكتبش أسماءها بإيده.
- الإعدادات الافتراضية لو الواجهة ما بعتتش حاجة: `APP_NAME: "POS Core API"`, `COLLECTION_PREFIX: "pos_"`, `DEFAULT_BRAND: ""`.

---

## 1.5) الفلوس وطرق الدفع

كل حاجة ليها علاقة بالفلوس بقت إعدادات (`core/config.ts`، والمنطق في `core/payments.ts`):

| الإعداد | المعنى |
|---|---|
| `CURRENCY` / `CURRENCY_SYMBOL` | كود العملة اللي بيرجع مع أرصدة الخزنة، والرمز اللي بيتكتب في ملاحظات الحسابات والرسايل |
| `PAYMENT_METHODS` | طرق الدفع بالترتيب. كل طريقة: `name` (الاسم اللي بيتخزن على الفاتورة)، `channel` (`cash` = درج الكاش، `visa` = ماكينة الكارت، `wallets` = محافظ وتحويلات)، `credit: true` لطريقة "الآجل"، `aliases` لأسماء تانية بنفس المعنى، و`matchPrefix: true` لو أي قيمة بتبدأ بالاسم تتحسب نفس الطريقة |
| `DEFAULT_CUSTOMER_NAME` / `DEFAULT_CUSTOMER_TYPE` | اسم العميل في البيع من غير عميل مسجل، ونوع العميل الجديد |

- الطريقة الافتراضية لأي عملية من غير طريقة دفع = **أول طريقة `cash` مش `credit`**.
- الفاتورة بطريقة `credit` ما بيتحصلش منها حاجة إلا لو اتبعت `paidAmount` (مقدم).
- طريقة دفع مش موجودة في القائمة بتتحسب على `wallets` (زي ما كان قبل كده).
- القنوات الـ 3 (`cash`/`visa`/`wallets`) ثابتة، لأن تقفيل الشيفت والخزنة والواجهة بيعتمدوا عليها.
- `GET /app-info` بيرجّع `currency` و`paymentMethods` و`defaults.paymentMethod`، عشان الواجهة تعرضهم من غير ما تكتبهم بإيدها.
- القيم الافتراضية في الـ core هي بتاعة Nelly، وNelly كمان كاتباها صريحة في `core.config.json`.

## 2) المقاسات والألوان (Variants)

### الفكرة
كل variant (مثلاً "تيشيرت بولو - أسود / L") **صنف كامل لوحده** في `shop_products` (أو `products` للمخزن)، ليه باركود وكمية وسعر خاصين بيه. الـ variants بتاعة نفس الموديل مربوطة ببعض بـ `groupId`. ده نفس الأسلوب اللي Shopify وأغلب أنظمة الكاشير ماشية بيه، وميزته إن البيع والمرتجعات والمشتريات والتحويلات والجرد والتزامن وسجل حركة المخزون **كلهم شغالين على الـ variant من غير أي تعديل**، لأنهم أصلاً شغالين على مستوى الصنف.

أعمدة جديدة في `shop_products` و`products` (migration رقم 7، بتتضاف لوحدها لما البرنامج يفتح):

| العمود | المعنى |
|---|---|
| `groupId` | id الموديل. الأصناف اللي ليها نفس `groupId` هي variants لنفس الموديل. `NULL` = صنف عادي من غير variants |
| `groupName` | اسم الموديل، مثلاً "تيشيرت بولو" |
| `variantLabel` | وصف الـ variant، مثلاً "أسود / L" |
| `attributes` | JSON بالخصائص، مثلاً `{"اللون":"أسود","المقاس":"L"}` (المفاتيح حرة: مقاس، لون، خامة، حجم...) |

`name` للـ variant بيتحسب لوحده = `groupName - variantLabel`، فالفاتورة والمرتجع والتقارير والبحث كلها بتعرض الاسم الكامل.

### الـ Endpoints
نفس الـ endpoints متاحة للمحل تحت `/shop/product-groups` وللمخزن تحت `/product-groups`:

| Method | Path | الوظيفة |
|---|---|---|
| GET | `/shop/product-groups?search=&category=&includeSingles=1&limit=` | الموديلات، وتحت كل موديل الـ variants بتاعته وإجمالي الكمية وأقل/أعلى سعر. `includeSingles=1` بيرجّع الأصناف العادية كمان (كل صنف كمجموعة فيها عنصر واحد) |
| POST | `/shop/product-groups` | إنشاء موديل بكل الـ variants بتاعته في عملية واحدة |
| GET | `/shop/product-groups/{groupId}` | موديل واحد بالـ variants بتاعته |
| PUT/PATCH | `/shop/product-groups/{groupId}` | تعديل البيانات المشتركة (الاسم، التصنيف، البراند، الوصف، حد التنبيه). ولو بعت `applyToAll: true` مع الأسعار، بتتطبق على كل الـ variants |
| POST | `/shop/product-groups/{groupId}/variants` | إضافة variants جديدة لموديل موجود |
| DELETE | `/shop/product-groups/{groupId}` | حذف الموديل كله (للمدير فقط) |

`GET /shop/products?groupId=...` بيرجّع الـ variants بتاعة موديل معيّن كقائمة أصناف عادية. وتعديل variant واحد (السعر، الكمية، الباركود، أو `attributes`/`variantLabel`) بيتم من `PUT /shop/products/{id}` العادي.

### مثال: إنشاء موديل
```json
POST /shop/product-groups
{
  "name": "تيشيرت بولو",
  "category": "تيشيرتات",
  "costPrice": 150, "sellingPrice": 300,
  "options": [
    { "name": "اللون", "values": ["أسود", "أبيض"] },
    { "name": "المقاس", "values": ["M", "L", "XL"] }
  ],
  "variants": [
    { "attributes": { "اللون": "أسود", "المقاس": "L" }, "barcode": "100200", "quantity": 5 },
    { "attributes": { "اللون": "أبيض", "المقاس": "XL" }, "quantity": 2, "sellingPrice": 320 }
  ]
}
```
- لو بعت `options` من غير `variants`، كل التباديل بتتعمل لوحدها (2 لون × 3 مقاس = 6 variants بكمية صفر).
- لو بعت الاتنين، الـ variants المكتوبة بس هي اللي بتتعمل، والمفاتيح لازم تكون من الـ options.
- كل variant ممكن يكون ليه سعر أو تكلفة أو حد تنبيه خاص بيه، ولو مش موجود بياخد قيمة الموديل.
- الباركود لازم يكون مش مستخدم لصنف تاني (409 `DUPLICATE_BARCODE`)، ونفس تركيبة الخصائص ما ينفعش تتكرر جوه الموديل (409 `DUPLICATE_VARIANT`).

### في الفواتير
بند الفاتورة بيتخزن فيه `groupId` و`groupName` و`variantLabel` و`attributes` للـ variant اللي اتباع. والمرتجعات وفواتير المشتريات والتحويل بين المخزن والمحل بيحافظوا على بيانات الـ variant، حتى لو الصنف اتعمل من جديد في المكان التاني.

---

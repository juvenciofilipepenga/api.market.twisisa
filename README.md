# Twisisa Market Backend v0.6.0

Backend base for Twisisa Market, using Fastify, TypeScript, Prisma Client and Neon PostgreSQL.

## Architecture

- Prisma Client: application database access and type-safe queries.
- JavaScript migrations: database schema source of truth. Prisma Migrate is intentionally not used.
- Socket.IO: real-time event transport.
- PDFKit: invoice PDF generation.
- Cloudinary: product image storage when configured.
- Payment provider abstraction: manual payment (M-Pesa/e-Mola by phone, or Visa card as an offline/manual flow) and a configurable ZumboPay REST adapter, so checkout keeps working when ZumboPay's API is unavailable.
- Support chat: a deterministic menu plus an optional Groq-backed assistant for simple FAQs, escalating to an admin queue for anything else, with real-time delivery over Socket.IO and image/file attachments via Cloudinary.

## First deploy checklist

1. `npm install && npm run check` (this was not run in this environment — no network access — so run it yourself before deploying).
2. Provision Neon Postgres, set `DATABASE_URL`/`DIRECT_URL`, run `npm run migrate`.
3. Generate a real `JWT_SECRET` (see `.env.example`) and set `CORS_ORIGIN` to your real frontend origin (several origins can be listed, comma-separated).
4. Only run `npm run seed` in development/staging: in `NODE_ENV=production` it does nothing on purpose, so create your first admin manually (e.g. a one-off script using `hashPassword` from `src/lib/auth.ts`).
5. Preferred: deploy to a host that keeps a long-running process (Render, Railway, Fly), since Socket.IO needs persistent connections and `src/server.ts` is the entry point (`npm start`).
   Vercel is supported only as a degraded mode through `api/index.ts` + `vercel.json` (serverless, no Socket.IO): the REST API works, but real-time events (chat, notifications) are silently dropped, so clients must fall back to polling `GET /api/v1/notifications` and `GET /api/v1/chat/conversations/:id/messages`.
6. Set `NODE_ENV=production` so the app trusts the platform's reverse proxy (`trustProxy`) for the real client IP.
7. Configure Cloudinary if you need product/chat images, and `ZUMBOPAY_*` if/when the gateway is ready; both are optional and the app runs without them (manual payments and file-less chat still work).
8. Set `GROQ_API_KEY` if you want the support chat to answer free-text questions; without it, anything beyond the numbered menu is escalated straight to an admin.

## Admin management endpoints (all require an ADMIN/SUPER_ADMIN token)

- `POST /api/v1/admin/categories` — create a category.
- `POST /api/v1/admin/products`, `PATCH /api/v1/admin/products/:id` — create/update a product (price, stock, description, category).
- `POST /api/v1/admin/products/:id/stock` — adjust stock by a signed delta; rejected if it would go negative.
- `POST /api/v1/admin/products/:id/images` (after `POST /api/v1/media/image`), `DELETE /api/v1/admin/products/:id/images/:imageId`.
- `POST /api/v1/admin/orders/:id/status` — advance an order through its lifecycle (`PROCESSING` → `READY_FOR_SHIPMENT` → `SHIPPED` → `OUT_FOR_DELIVERY` → `DELIVERED`, plus `CANCELLATION_REQUESTED`/`REFUND_PENDING`/`REFUNDED`); only the transitions listed in `adminTransitions` (`src/routes/orders.ts`) are allowed (including `CANCELLATION_REQUESTED` → `CANCELLED`). Stock is restocked exactly once: on `CANCELLED`, or on `REFUNDED` if the order never went through `CANCELLED`.
- `PATCH /api/v1/admin/users/:id/status` — set an account to `ACTIVE`/`SUSPENDED`/`BLOCKED`. An admin cannot change their own status; only a `SUPER_ADMIN` can change admin accounts. Existing access tokens stay valid until they expire (`JWT_EXPIRES_IN`); new logins are refused immediately.
- `GET /api/v1/admin/chat/conversations`, `POST /api/v1/admin/chat/conversations/:id/reply`, `POST /api/v1/admin/chat/conversations/:id/close`.

## Catalogue, variants and reviews

- Products may have variants (`colorHex` and/or `size`, each with its own `stock`). When a product has active variants, `Product.stock` is the sum of the variants' stock and `POST /api/v1/orders` requires a `variantId` per item; stock is decremented on both the variant and the product, and restocked on both when an order is cancelled/refunded.
- `PATCH /api/v1/admin/products/:id` with `variants` syncs by (colour, size): matching variants are updated in place, new ones are created, and variants left out are deactivated with stock 0 (never deleted, so past orders keep their `variantId`).
- `POST /api/v1/admin/products/:id/stock` is rejected with `VARIANT_STOCK_MANAGED_IN_FORM` for products with variants.
- `GET /api/v1/products/:id/reviews` is public; `POST` requires auth and a paid/shipped/delivered order containing the product (`PURCHASE_REQUIRED` otherwise), one review per user per product.
- Other endpoints: `/notifications` (list, read, delete), `/referrals/me`, `/referrals/lookup/:code`, `/invoices/:id` and `/invoices/:id/pdf`, `/users/me`, `/admin/users`, `/admin/categories` (PATCH/DELETE), `/admin/products` (list, DELETE, `bulk`).

## Payments

- The database allows only one *active* payment per order (partial unique index, migration `005`); concurrent initiations get `PAYMENT_ALREADY_ACTIVE`. If an admin rejects a proof, the order goes back to `PENDING_PAYMENT` so the customer can resubmit or pick another method.

- `POST /api/v1/orders/:id/payments/initiate` only works while the order is `PENDING_PAYMENT`, and only one active payment is allowed per order at a time.
- `provider: "MANUAL"` requires `method: "MPESA"` or `"EMOLA"` with a matching Mozambican phone number (`84`/`85` for M-Pesa, `86`/`87` for e-Mola, with or without the `258` prefix), or `method: "CARD"` with no card number — card payment is handled offline (e.g. POS on delivery); this backend never receives or stores card numbers. The customer then submits proof via `POST /api/v1/payments/:id/proof`, and an admin approves/rejects it via `POST /api/v1/admin/payments/:id/review`.
- `provider: "ZUMBOPAY"` runs the real flow described under "Payments flow" below. `provider: "MANUAL"` (proof upload + admin review) stays available as a fallback.

## Support chat

- `POST /api/v1/chat/conversations` opens (or resumes) the customer's conversation and returns the bot's greeting with a numbered menu.
- `POST /api/v1/chat/conversations/:id/messages` accepts JSON (`{ "content": "..." }`) or `multipart/form-data` with a `content` field plus up to 5 file parts (images or PDF, 10 MB each) for attachments.
- While a conversation is in the `BOT` state, replies matching the menu are answered from real data (the customer's own latest order/payment — never invented), free text is sent to Groq (`GROQ_API_KEY`) with a strict system prompt, and anything Groq can't answer, or that a customer asks for a human, moves the conversation to `ESCALATED` and notifies admins in real time (`chat.message` / `admin.alert` Socket.IO events). Without `GROQ_API_KEY`, everything beyond the two menu options escalates immediately — no fabricated answers.
- Once `ESCALATED`, the bot stops answering; an admin must reply via `POST /api/v1/admin/chat/conversations/:id/reply` (same body shape), and can close the conversation.

## Setup

```bash
cp .env.example .env
npm install
npm run prisma:validate
npm run generate
npm run migrate:status
npm run migrate
npm run seed
npm run build
npm test
npm run lint
```

For Neon migrations, `DIRECT_URL` is preferred by the migration runner when present. The application continues using `DATABASE_URL` through Prisma.

## Migration rules

Do not use `prisma migrate dev`, `prisma migrate deploy`, or `prisma migrate status`.

Use:

```bash
npm run migrate
npm run migrate:status
npm run migrate:rollback
```

Each migration is numbered, executed in order, wrapped in a transaction, and stored with a SHA-256 checksum in `_schema_migrations`.

Never patch the database with ad-hoc scripts outside `migrations/`; if a migration was already applied by hand, make it idempotent (`IF NOT EXISTS`) instead. Never edit a migration that is already recorded in `_schema_migrations` (the runner aborts with `Migration checksum changed`).

## Health

`GET /api/v1/health`

Expected response:

```json
{"status":"ok","service":"twisisa-market-api"}
```

## Security notes

- Secrets belong only in `.env` or the deployment secret manager.
- The frontend must never receive gateway API keys.
- Order totals are calculated server-side: item prices come from the catalogue, shipping from `SHIPPING_FLAT_MZN`, and discounts are never accepted from the client.
- Payment success is confirmed server-side; a customer proof is not automatically trusted.
- `POST /api/v1/payments/:id/webhook` always requires `ZUMBOPAY_WEBHOOK_SECRET` (sent in the `x-twisisa-webhook-secret` header, compared in constant time). Without it the endpoint answers 503 in every environment. Only ZUMBOPAY payments are accepted, and replays of an already confirmed payment are ignored.
- `JWT_SECRET` has no default: generate one (see `.env.example`). Placeholder values are rejected at startup.
- Empty optional variables copied from `.env.example` are treated as unset.
- The sample seed password is for local development only and must be changed before any real deployment.


## Payments flow (ZumboPay)

Checkout → `/pagamento/:orderId`: choose method (M-Pesa, e-Mola, Visa/Mastercard) → phone number → Pay → waiting screen → celebration **only after the server confirms the payment with ZumboPay**.

- `GET  /api/v1/payments/methods` – methods that are really available (wallet configured) + sandbox flag.
- `POST /api/v1/orders/:id/payments/initiate` – `{provider:"ZUMBOPAY", method:"MPESA"|"EMOLA", paymentNumber}` sends the STK push (`POST /charges`); `{method:"CARD"}` returns a hosted 3DS `checkoutUrl`. If the order already has an active payment the answer is `409 PAYMENT_ALREADY_ACTIVE` with its `paymentId`, which is how a pending payment is resumed.
- `GET  /api/v1/payments/:id/status` – polled by the waiting screen every 3 s. Each call asks ZumboPay (`GET /payments/{reference}`) and returns `state: pending | success | failed` plus `failureKind` (`WRONG_PIN`, `INSUFFICIENT_FUNDS`, `CANCELLED`, `TIMEOUT`, `AMOUNT_MISMATCH`, `UNAVAILABLE`, `UNKNOWN`).
- `POST /api/v1/payments/:id/cancel` – "change method"; never cancels a payment ZumboPay already confirmed.
- `POST /api/v1/webhooks/zumbopay` – HMAC SHA-256 over `${X-Timestamp}.${raw body}` (5 min window) using `ZUMBOPAY_WEBHOOK_SECRET`. The webhook only *wakes up* the verification; the state always comes from `GET /payments/{reference}`.

Rules enforced in `services/paymentFlow.ts` (single entry point `settlePayment`): amount and currency (MZN) must match the order, e-Mola needs proof of PIN (same rule as the official WooCommerce plugin), the order only becomes `PAID` in a conditional transaction (polling + webhook cannot double-process), the invoice is issued only after that, a network error never marks a payment as failed, and a late webhook after a timeout still pays the order.

Setup: set `ZUMBOPAY_ENABLED=true`, `ZUMBOPAY_API_KEY`, `ZUMBOPAY_WEBHOOK_SECRET`, the wallet ids `ZUMBOPAY_WALLET_MPESA|EMOLA|CARD` (UUIDs from ZumboPay's `GET /wallets`) and register `<APP_PUBLIC_URL>/api/v1/webhooks/zumbopay` in the ZumboPay dashboard. For local demos use `ZUMBOPAY_MOCK=true` (refused in production): the last digit of the phone picks the outcome (0 wrong PIN, 1 insufficient funds, 2 cancelled, 3 expires, other success after ~7 s).

## Invoice

`InvoiceSettings` (admin → *Fatura*) holds company name, NUIT, address, contacts, logo, accent colour, signature image + signer, number prefix, VAT %, footer, terms and bank details. Invoice numbers are sequential (`FT-2026-000001`) from an atomic counter. Every invoice stores a **copy** of the issuer data (`Invoice.issuer`) when issued, so editing the settings never rewrites old invoices. `GET /api/v1/admin/invoice-settings/preview` renders a sample PDF with the saved settings.

## Partial checkout and tracking

- The cart lets the customer **select** which items to pay now. `POST /orders` receives only those; the cart is **not** emptied at that point. Paid items leave the cart only after the payment is confirmed (`PaymentPage`, or `CartReconciler` if the customer closed the page), and unselected items always stay. An unpaid order with exactly the same items is reused instead of duplicated.
- Tracking for paid orders: `POST /admin/orders/:id/tracking` (location, note, estimated arrival date, carrier, tracking code) adds a history entry without changing the status and notifies the customer. `POST /admin/orders/:id/status` accepts the same optional fields. The customer sees them in the order page (*Acompanhamento* card + history).

## Plan B when ZumboPay fails (manual payment)

- **Manual payment** (no third party, no company registration needed): M-Pesa or e-Mola, paid to the store's own number. Flow: the customer enters the **number and account name they will pay from** → sees the store's card (name, number, exact amount) → taps **Enviar pedido** → pays in their own app → taps **Já paguei** (optionally adding the message code). Requests that are never claimed **expire by themselves** and never reach the admin. A payer number can only have one active request at a time (that is how two simultaneous payments are told apart).

**Payment deadline (per order).** The clock starts when the order is sent (`Order.createdAt`), not when the payment screen is opened: `ORDER_PAYMENT_WINDOW_SECONDS` (default 1800 = 30 min). Every payment's `expiresAt` is capped to that deadline. If the timer runs out, "Já paguei" still works for 2 more minutes (`MANUAL_CLAIM_GRACE_MS` = `EXPIRY_GRACE_MS`; someone who paid in the last second is not lost). After that, `services/orderExpiry.ts` cancels the order (`cancellationReason = PAYMENT_EXPIRED`), puts the stock back and closes open payments. It runs every minute in `server.ts` and, for serverless, whenever `GET /orders` or `GET /orders/:id` is read. Orders already in `PAYMENT_REVIEW` (customer said "Já paguei") never expire: they wait for the admin.

**`GET /orders?tab=`** — `all | wallet | p2p | refused` (rules in `services/orderTabs.ts`). `wallet` = paid and confirmed (admin approval or ZumboPay); `p2p` = waiting (to pay / awaiting admin) or expired; `refused` = proof rejected and nothing else in progress. The response also carries `counts` per tab and `serverNow`; each row has `phase`, `expired` and `paymentDeadline`. `GET /orders/:id` adds `paymentDeadline`, `deliveryDeadlineAt` (confirmation + `DELIVERY_MAX_DAYS`, default 15) and `serverNow`.
- **Confirmation is always human**: *Admin → Pagamentos → Pagamentos a confirmar* lists only claimed payments (amount, payer name and number, time). The admin checks the **wallet/bank history** for that amount, from that number, at that time, ticks the confirmation box and approves; approval runs the normal flow (order paid, invoice, tracking). No website can see the operator's data, so there is no automatic confirmation here.
- **Admin → Pagamentos**: instant switches for online payment and manual payment (no redeploy), and the store's receiving details.
- **Circuit breaker**: 3 ZumboPay failures (network, 5xx, 401/403/429) within 5 minutes switch customers to manual payment for 10 minutes (state stored in `PaymentSettings`, so it works on serverless). A wrong phone number does not count. Admins are notified, and can re-enable ZumboPay immediately.
- `POST /api/v1/payments/:id/claim` is the "Já paguei" action and `GET /api/v1/admin/payments/pending-review` feeds the admin list. `GET /api/v1/payments/methods` returns `methods` (online, empty when switched off or tripped), `onlineStatus` and `manual` (destinations, only when at least one is filled in).

## Flexible catalog (phase 1: database and server)

- **Category attributes** (Marca, RAM, Material…): defined per category by the admin, no code changes. Types `TEXT`, `NUMBER`, `BOOLEAN`, `SELECT`, `MEASURE`; flags `required`, `showPublic`, `filterable`, `sortOrder`. Endpoints: `GET/POST /admin/categories/:id/attributes`, `PATCH/DELETE /admin/category-attributes/:id`. A product's values are saved with `attributes: [{ attributeId, value }]` on `POST/PATCH /admin/products`.
- **Variants** carry `options` (e.g. `{"Cor":"#000000","Tamanho":"M"}`, or `{"Capacidade":"256 GB"}`), optional `sku` and optional `priceMzn`. The old `colorHex`/`size` inputs still work and keep being filled. Duplicate combinations are rejected by a database index (`optionKey`, active variants) and in the API; SKUs are unique among active variants.
- **Sources of truth:** price = variant price if set, else product price. Stock = sum of active variants when the product has variants (the product's own `stock` is ignored and the API returns the computed total), else the product's stock. The server decides price and availability for every order line (`services/catalog.ts: resolveOrderLine`) and stores the variant text and SKU on the order item.
- `GET /products`, `GET /products/:id` and the admin endpoints now also return `optionDefs`, `attributes`, `priceFromMzn`, and per-variant `options` / `effectivePriceMzn`.
- **Admin screens (phase 2):** *Categorias → Características* (define the specifications of each category) and the product form in 7 sections (general info, category, images, price and inventory, specifications, variants, publication) with a flexible variant editor (any options, only the combinations actually sold, optional SKU and price per variant, deactivate/reactivate).
- **Store (phase 3):** the product page shows the specifications table and a generic option picker: a value that does not exist, has no stock, or does not combine with what was already chosen is struck through and cannot be selected; the price follows the chosen variant (or shows "A partir de").
## Admin panel: attention first

- `GET /api/v1/admin/attention`: everything waiting for the admin, oldest first (claimed manual payments count, paid orders to prepare with payer name/number/time, cancellation requests, refunds, escalated chats, low stock using the variants' total). `GET /api/v1/admin/history?page=&limit=`: paid / shipped / delivered / cancelled events, 10 at a time.
- `GET /api/v1/admin/orders` accepts `bucket=action|ongoing|done` (3 tabs instead of 12 statuses: `services/orderBuckets.ts`) and `q=` (order number, customer name or email). *Needs action* is sorted oldest-first.
- Store: every page opens at the top (also the admin area), the footer only shows on the home page and legal pages, the review form opens from a button, order numbers are shown short (`#9881DB2E`, full number on tap/detail), disabled primary buttons are readable.

- `node scripts/inspect-catalog.js` prints the real catalog schema and data-quality checks (read-only).

After pulling these changes run `npm run migrate` (migrations `008` to `012`) and `npm run generate` (new Prisma models and columns).

## Price calculator (admin only)
The product price is **calculated on the server**, never typed. Costs live in their own table (`ProductPricing`, migration 013), not on `Product`, so public lists can never leak costs or margins (`present()` also strips `pricing` for public responses). Formula and rounding: `services/pricing.ts` (mirrored for live preview in `frontend/src/lib/pricing.ts`; `tests/pricing.test.ts` pins the values).

`total cost = purchase × (1 + tax%) + transport + other` · `list price = total cost × (1 + return%) ÷ (1 − commission%)` · `customer price = list price × (1 − discount%)`, rounded **up** to the metical · `profit = customer price × (1 − commission%) − total cost` · `real return = profit ÷ total cost`. `Product.priceMzn` stores the customer price. Limits: commission ≤ 60%, discount ≤ 50% (validated here). Profit levels (red below "good", green from "good", strong green from "excellent"; defaults 30% / 80%) are editable via `GET/PUT /admin/pricing-settings`. `POST/PATCH /admin/products` and `/admin/products/bulk` accept `pricing`; without it, `priceMzn` still works as before (products with no costs keep their old price). After pulling this change run `npm run migrate` and `npx prisma generate`.

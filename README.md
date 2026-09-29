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
3. Generate a real `JWT_SECRET` (see `.env.example`) and set `CORS_ORIGIN` to your real frontend origin.
4. Only run `npm run seed` in development/staging: in `NODE_ENV=production` it does nothing on purpose, so create your first admin manually (e.g. a one-off script using `hashPassword` from `src/lib/auth.ts`).
5. Deploy to a host that keeps a long-running process (Render, Railway, Fly — not a serverless platform), since Socket.IO needs persistent connections.
6. Set `NODE_ENV=production` so the app trusts the platform's reverse proxy (`trustProxy`) for the real client IP.
7. Configure Cloudinary if you need product/chat images, and `ZUMBOPAY_*` if/when the gateway is ready; both are optional and the app runs without them (manual payments and file-less chat still work).
8. Set `GROQ_API_KEY` if you want the support chat to answer free-text questions; without it, anything beyond the numbered menu is escalated straight to an admin.

## Admin management endpoints (all require an ADMIN/SUPER_ADMIN token)

- `POST /api/v1/admin/categories` — create a category.
- `POST /api/v1/admin/products`, `PATCH /api/v1/admin/products/:id` — create/update a product (price, stock, description, category).
- `POST /api/v1/admin/products/:id/stock` — adjust stock by a signed delta; rejected if it would go negative.
- `POST /api/v1/admin/products/:id/images` (after `POST /api/v1/media/image`), `DELETE /api/v1/admin/products/:id/images/:imageId`.
- `POST /api/v1/admin/orders/:id/status` — advance an order through its lifecycle (`PROCESSING` → `READY_FOR_SHIPMENT` → `SHIPPED` → `OUT_FOR_DELIVERY` → `DELIVERED`, plus `CANCELLATION_REQUESTED`/`REFUND_PENDING`/`REFUNDED`); only the transitions listed in `adminTransitions` (`src/routes/orders.ts`) are allowed, and moving to `REFUNDED` restocks the items.
- `GET /api/v1/admin/chat/conversations`, `POST /api/v1/admin/chat/conversations/:id/reply`, `POST /api/v1/admin/chat/conversations/:id/close`.

## Payments

- `POST /api/v1/orders/:id/payments/initiate` only works while the order is `PENDING_PAYMENT`, and only one active payment is allowed per order at a time.
- `provider: "MANUAL"` requires `method: "MPESA"` or `"EMOLA"` with a matching Mozambican phone number (`84`/`85` for M-Pesa, `86`/`87` for e-Mola, with or without the `258` prefix), or `method: "CARD"` with no card number — card payment is handled offline (e.g. POS on delivery); this backend never receives or stores card numbers. The customer then submits proof via `POST /api/v1/payments/:id/proof`, and an admin approves/rejects it via `POST /api/v1/admin/payments/:id/review`.
- `provider: "ZUMBOPAY"` calls the configured gateway; if it's down or `ZUMBOPAY_ENABLED=false`, switch the frontend to `provider: "MANUAL"` so customers can still pay.

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

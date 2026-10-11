import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConversationStatus, OrderStatus, PaymentStatus, Prisma, RoleName } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const adminOnly = [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)];
const LOW_STOCK = 5;
const LIST = 8;
const HISTORY_STATES = ["PAID", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"];

// Stock efetivo: com variantes ativas, a soma delas; sem variantes, o do produto (mesma regra do catálogo).
const effectiveStock = Prisma.sql`
  SELECT p.id, p.name,
    (CASE WHEN EXISTS (SELECT 1 FROM "ProductVariant" v WHERE v."productId" = p.id AND v.active)
      THEN (SELECT COALESCE(SUM(v.stock), 0)::int FROM "ProductVariant" v WHERE v."productId" = p.id AND v.active)
      ELSE p.stock END) AS stock
  FROM "Product" p WHERE p.active`;

export async function adminAttentionRoutes(app: FastifyInstance): Promise<void> {
  // "O que precisa de si agora": tudo o que está à espera do admin, com quem, quanto e desde quando. As mais antigas primeiro.
  app.get("/admin/attention", { preHandler: adminOnly }, async (_request, reply) => {
    const orderLite = { id: true, orderNumber: true, totalMzn: true, updatedAt: true, user: { select: { name: true } } } as const;
    const [paymentsToConfirm, toPrepareTotal, toPrepare, cancelTotal, cancelRequests, refundTotal, refunds, chatTotal, chats, lowItems, lowTotal] = await Promise.all([
      prisma.payment.count({ where: { provider: "MANUAL", status: { in: [PaymentStatus.PROOF_SUBMITTED, PaymentStatus.UNDER_REVIEW] } } }),
      prisma.order.count({ where: { status: OrderStatus.PAID } }),
      prisma.order.findMany({
        where: { status: OrderStatus.PAID }, orderBy: { updatedAt: "asc" }, take: LIST,
        select: {
          ...orderLite,
          items: { select: { productName: true, quantity: true } },
          payments: { where: { status: { in: [PaymentStatus.SUCCESS, PaymentStatus.PAYMENT_CONFIRMED] } }, select: { confirmedAt: true, method: true, payerName: true, paymentNumber: true }, take: 1 }
        }
      }),
      prisma.order.count({ where: { status: OrderStatus.CANCELLATION_REQUESTED } }),
      prisma.order.findMany({ where: { status: OrderStatus.CANCELLATION_REQUESTED }, orderBy: { updatedAt: "asc" }, take: LIST, select: orderLite }),
      prisma.order.count({ where: { status: OrderStatus.REFUND_PENDING } }),
      prisma.order.findMany({ where: { status: OrderStatus.REFUND_PENDING }, orderBy: { updatedAt: "asc" }, take: LIST, select: orderLite }),
      prisma.conversation.count({ where: { status: ConversationStatus.ESCALATED } }),
      prisma.conversation.findMany({
        where: { status: ConversationStatus.ESCALATED }, orderBy: { lastMessageAt: "asc" }, take: LIST,
        select: { id: true, lastMessageAt: true, user: { select: { name: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1, select: { content: true } } }
      }),
      prisma.$queryRaw<Array<{ id: string; name: string; stock: number }>>`SELECT * FROM (${effectiveStock}) s WHERE s.stock <= ${LOW_STOCK} ORDER BY s.stock ASC, s.name ASC LIMIT ${LIST}`,
      prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM (${effectiveStock}) s WHERE s.stock <= ${LOW_STOCK}`
    ]);

    const lite = (o: (typeof cancelRequests)[number]) => ({ id: o.id, orderNumber: o.orderNumber, customer: o.user.name, totalMzn: o.totalMzn.toString(), since: o.updatedAt.toISOString() });
    const counts = {
      paymentsToConfirm, toPrepare: toPrepareTotal, cancelRequests: cancelTotal, refunds: refundTotal, chats: chatTotal, lowStock: lowTotal[0]?.n ?? 0
    };
    reply.header("Cache-Control", "no-store");
    return {
      counts: { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) },
      toPrepare: toPrepare.map((o) => {
        const paid = o.payments[0];
        return {
          ...lite(o),
          since: (paid?.confirmedAt ?? o.updatedAt).toISOString(),
          items: o.items.slice(0, 3).map((i) => ({ name: i.productName, quantity: i.quantity })),
          itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
          method: paid?.method ?? null, payerName: paid?.payerName ?? null, payerNumber: paid?.paymentNumber ?? null
        };
      }),
      cancelRequests: cancelRequests.map(lite),
      refunds: refunds.map(lite),
      chats: chats.map((c) => ({ id: c.id, customer: c.user.name, since: c.lastMessageAt.toISOString(), preview: c.messages[0]?.content?.slice(0, 120) ?? null })),
      lowStock: lowItems
    };
  });

  // Histórico: pagamentos confirmados, envios, entregas e cancelamentos, do mais recente para o mais antigo ("Ver mais" pede a página seguinte).
  app.get("/admin/history", { preHandler: adminOnly }, async (request, reply) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(30).default(10) }).parse(request.query);
    const rows = await prisma.$queryRaw<Array<{ id: string; at: Date; to: string; reason: string | null; orderId: string; orderNumber: string; totalMzn: Prisma.Decimal; customer: string }>>`
      SELECT h.id, h."createdAt" AS at, h."to"::text AS "to", h.reason, o.id AS "orderId", o."orderNumber", o."totalMzn", u.name AS customer
      FROM "OrderStatusHistory" h
      JOIN "Order" o ON o.id = h."orderId"
      JOIN "User" u ON u.id = o."userId"
      WHERE h."to"::text IN (${Prisma.join(HISTORY_STATES)}) AND h."from" IS DISTINCT FROM h."to"
      ORDER BY h."createdAt" DESC
      LIMIT ${q.limit + 1} OFFSET ${(q.page - 1) * q.limit}`;
    reply.header("Cache-Control", "no-store");
    return {
      items: rows.slice(0, q.limit).map((r) => ({ id: r.id, at: r.at.toISOString(), status: r.to, note: r.reason, orderId: r.orderId, orderNumber: r.orderNumber, totalMzn: r.totalMzn.toString(), customer: r.customer })),
      hasMore: rows.length > q.limit
    };
  });
}

import type { FastifyInstance } from "fastify";
import { OrderStatus, RoleName, ConversationStatus } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const adminOnly = [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)];

// Uma venda conta como receita quando já foi paga e não foi cancelada nem reembolsada.
const REVENUE_STATUSES: OrderStatus[] = [
  OrderStatus.PAID, OrderStatus.PROCESSING, OrderStatus.READY_FOR_SHIPMENT,
  OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED
];
const LOW_STOCK = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
// Moçambique (Africa/Maputo) é UTC+2 sem horário de Verão: os "dias" do gráfico fecham à meia-noite local.
const LOCAL_OFFSET_MS = 2 * 60 * 60 * 1000;
const MAX_ROWS = 50_000;

const dayKey = (d: Date) => new Date(d.getTime() + LOCAL_OFFSET_MS).toISOString().slice(0, 10);
const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

export async function adminStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/stats", { preHandler: adminOnly }, async (request, reply) => {
    const q = z.object({ days: z.coerce.number().int().refine((d) => [7, 14, 30, 90].includes(d)).default(14) }).parse(request.query);

    const now = new Date();
    const startMs = Date.parse(`${dayKey(now)}T00:00:00.000Z`) - LOCAL_OFFSET_MS - (q.days - 1) * DAY_MS;
    const since = new Date(startMs);
    const prevSince = new Date(startMs - q.days * DAY_MS);

    const [paidRows, byStatus, topRaw, newCustomers, prevCustomers, activeProducts, lowStock, awaitingReview, pendingPayment, cancelRequests, refundPending, openChats, recent] = await Promise.all([
      prisma.order.findMany({ where: { createdAt: { gte: prevSince }, status: { in: REVENUE_STATUSES } }, select: { createdAt: true, totalMzn: true }, take: MAX_ROWS }),
      prisma.order.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.orderItem.groupBy({
        by: ["productName"],
        where: { order: { createdAt: { gte: since }, status: { in: REVENUE_STATUSES } } },
        _sum: { quantity: true, subtotalMzn: true },
        orderBy: { _sum: { subtotalMzn: "desc" } },
        take: 5
      }),
      prisma.user.count({ where: { createdAt: { gte: since }, roles: { none: { role: { name: { in: [RoleName.ADMIN, RoleName.SUPER_ADMIN] } } } } } }),
      prisma.user.count({ where: { createdAt: { gte: prevSince, lt: since }, roles: { none: { role: { name: { in: [RoleName.ADMIN, RoleName.SUPER_ADMIN] } } } } } }),
      prisma.product.count({ where: { active: true } }),
      prisma.product.count({ where: { active: true, stock: { lte: LOW_STOCK } } }),
      prisma.order.count({ where: { status: OrderStatus.PAYMENT_REVIEW } }),
      prisma.order.count({ where: { status: OrderStatus.PENDING_PAYMENT } }),
      prisma.order.count({ where: { status: OrderStatus.CANCELLATION_REQUESTED } }),
      prisma.order.count({ where: { status: OrderStatus.REFUND_PENDING } }),
      prisma.conversation.count({ where: { status: ConversationStatus.ESCALATED } }),
      prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 6, select: { id: true, orderNumber: true, status: true, totalMzn: true, createdAt: true, user: { select: { name: true } } } })
    ]);

    // Série diária (um ponto por dia, mesmo sem vendas, para o gráfico não "saltar" dias)
    const buckets = new Map<string, { revenueMzn: number; orders: number }>();
    for (let i = 0; i < q.days; i++) buckets.set(dayKey(new Date(startMs + i * DAY_MS)), { revenueMzn: 0, orders: 0 });
    let revenue = 0, orders = 0, prevRevenue = 0, prevOrders = 0;
    for (const row of paidRows) {
      const value = row.totalMzn.toNumber();
      if (row.createdAt >= since) {
        revenue += value; orders += 1;
        const bucket = buckets.get(dayKey(row.createdAt));
        if (bucket) { bucket.revenueMzn += value; bucket.orders += 1; }
      } else {
        prevRevenue += value; prevOrders += 1;
      }
    }

    const createdTotal = byStatus.reduce((sum, row) => sum + row._count._all, 0);

    reply.header("Cache-Control", "no-store");
    return {
      generatedAt: now.toISOString(),
      days: q.days,
      kpis: {
        revenueMzn: revenue, revenueDeltaPct: pct(revenue, prevRevenue),
        paidOrders: orders, paidOrdersDeltaPct: pct(orders, prevOrders),
        averageTicketMzn: orders > 0 ? Math.round(revenue / orders) : 0,
        newCustomers, newCustomersDeltaPct: pct(newCustomers, prevCustomers),
        ordersCreated: createdTotal,
        paymentConversionPct: createdTotal > 0 ? Math.round((orders / createdTotal) * 1000) / 10 : null
      },
      revenueByDay: [...buckets.entries()].map(([date, v]) => ({ date, ...v })),
      ordersByStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })).sort((a, b) => b.count - a.count),
      topProducts: topRaw.map((row) => ({
        name: row.productName,
        units: row._sum.quantity ?? 0,
        revenueMzn: row._sum.subtotalMzn?.toNumber() ?? 0
      })),
      attention: { awaitingReview, pendingPayment, cancelRequests, refundPending, openChats, lowStock },
      catalog: { activeProducts, lowStockThreshold: LOW_STOCK },
      recentOrders: recent.map((o) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status, totalMzn: o.totalMzn.toNumber(), createdAt: o.createdAt.toISOString(), customer: o.user.name }))
    };
  });
}

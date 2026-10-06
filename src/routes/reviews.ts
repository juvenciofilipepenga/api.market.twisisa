import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { OrderStatus, Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const idParams = z.object({ id: z.string().min(1) });
const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional()
});

// Só quem já pagou (ou recebeu) o produto pode avaliar.
const reviewableOrderStates: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.READY_FOR_SHIPMENT,
  OrderStatus.SHIPPED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED
];

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/products/:id/reviews", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const [reviews, summary] = await Promise.all([
      prisma.review.findMany({
        where: { productId: params.data.id },
        orderBy: { createdAt: "desc" },
        include: { user: { select: { name: true } } }
      }),
      prisma.review.aggregate({ where: { productId: params.data.id }, _avg: { rating: true }, _count: { _all: true } })
    ]);
    return {
      data: reviews.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, createdAt: r.createdAt, userName: r.user.name })),
      summary: { average: summary._avg.rating ?? 0, count: summary._count._all }
    };
  });

  app.post("/products/:id/reviews", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = reviewBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const userId = request.auth!.userId;

    const purchased = await prisma.orderItem.findFirst({
      where: { productId: params.data.id, order: { userId, status: { in: reviewableOrderStates } } }
    });
    if (!purchased) return reply.code(403).send({ error: "PURCHASE_REQUIRED" });

    try {
      const review = await prisma.review.create({
        data: { productId: params.data.id, userId, rating: body.data.rating, comment: body.data.comment || null },
        include: { user: { select: { name: true } } }
      });
      return reply.code(201).send(review);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "REVIEW_ALREADY_EXISTS" });
      }
      throw error;
    }
  });
}

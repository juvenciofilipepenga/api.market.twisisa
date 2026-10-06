import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/notifications", { preHandler: requireAuth }, async (request) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const [data, total] = await Promise.all([
      prisma.notification.findMany({ where: { userId: request.auth!.userId }, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.limit, take: q.limit }),
      prisma.notification.count({ where: { userId: request.auth!.userId } })
    ]);
    return { data, pagination: { page: q.page, limit: q.limit, total } };
  });

  app.post("/notifications/:id/read", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const notification = await prisma.notification.findFirst({ where: { id: params.data.id, userId: request.auth!.userId } });
    if (!notification) return reply.code(404).send({ error: "NOTIFICATION_NOT_FOUND" });
    return prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() } });
  });
  app.delete("/notifications/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const result = await prisma.notification.deleteMany({ where: { id: params.data.id, userId: request.auth!.userId } });
    if (result.count === 0) return reply.code(404).send({ error: "NOTIFICATION_NOT_FOUND" });
    return reply.code(204).send();
  });

  app.delete("/notifications", { preHandler: requireAuth }, async (request, reply) => {
    await prisma.notification.deleteMany({ where: { userId: request.auth!.userId } });
    return reply.code(204).send();
  });

}


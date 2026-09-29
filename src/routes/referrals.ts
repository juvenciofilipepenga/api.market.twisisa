import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

export async function referralRoutes(app: FastifyInstance): Promise<void> {
  app.get("/referrals/me", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: { referralCode: true, completedReferrals: true } });
    if (!user) return reply.code(404).send({ error: "USER_NOT_FOUND" });
    return user;
  });
}

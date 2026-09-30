import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { findActiveInviterByCode, firstName, normalizeReferralCode, referralStats } from "../services/referrals.js";

export async function referralRoutes(app: FastifyInstance): Promise<void> {
  // completedReferrals mantém o nome antigo (o frontend já o usa); invited/pending são novos.
  app.get("/referrals/me", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.auth!.userId;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
    if (!user) return reply.code(404).send({ error: "USER_NOT_FOUND" });
    const stats = await referralStats(userId);
    return {
      referralCode: user.referralCode,
      completedReferrals: stats.completed,
      pendingReferrals: stats.pending,
      invitedReferrals: stats.invited
    };
  });

  // Público (usado pela página de registo para mostrar "Convidado por …"). Só expõe o primeiro nome
  // e tem um limite de pedidos mais apertado do que o resto da API.
  app.get("/referrals/lookup/:code", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const params = z.object({ code: z.string() }).safeParse(request.params);
    const code = params.success ? normalizeReferralCode(params.data.code) : null;
    if (!code) return reply.code(404).send({ error: "REFERRAL_CODE_NOT_FOUND" });
    const inviter = await findActiveInviterByCode(code);
    if (!inviter) return reply.code(404).send({ error: "REFERRAL_CODE_NOT_FOUND" });
    return { valid: true, inviterFirstName: firstName(inviter.name) };
  });
}

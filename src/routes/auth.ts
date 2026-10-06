import type { FastifyInstance } from "fastify";
import { Prisma, RoleName } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { DUMMY_PASSWORD_HASH, hashPassword, signAccessToken, verifyPassword } from "../lib/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { findActiveInviterByCode, normalizeReferralCode, notifyReferralSignup } from "../services/referrals.js";

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(7).max(30).optional(),
  password: z.string().min(10).max(128),
  // Código de convite (opcional). Se for inválido o registo continua normalmente, só não fica associado.
  referralCode: z.string().trim().max(64).optional()
});
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    if (await prisma.user.findUnique({ where: { email: parsed.data.email } })) return reply.code(409).send({ error: "EMAIL_ALREADY_EXISTS" });
    if (parsed.data.phone && await prisma.user.findUnique({ where: { phone: parsed.data.phone } })) return reply.code(409).send({ error: "PHONE_ALREADY_EXISTS" });
    const role = await prisma.role.findUnique({ where: { name: RoleName.CUSTOMER } });
    if (!role) return reply.code(500).send({ error: "ROLE_NOT_INITIALIZED" });
    const referralCode = normalizeReferralCode(parsed.data.referralCode);
    const inviter = referralCode ? await findActiveInviterByCode(referralCode) : null;
    let user;
    try {
      user = await prisma.user.create({
        data: {
          name: parsed.data.name,
          email: parsed.data.email,
          phone: parsed.data.phone,
          passwordHash: await hashPassword(parsed.data.password),
          referredById: inviter?.id,
          roles: { create: { roleId: role.id } }
        },
        include: { roles: { include: { role: true } } }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: JSON.stringify(error.meta ?? {}).includes("phone") ? "PHONE_ALREADY_EXISTS" : "EMAIL_ALREADY_EXISTS" });
      }
      throw error;
    }
    const roles = user.roles.map((item) => item.role.name);
    await audit({ actorId: user.id, action: "USER_REGISTERED", entity: "User", entityId: user.id, ip: request.ip, userAgent: request.headers["user-agent"], metadata: inviter ? { referredById: inviter.id } : undefined });
    if (inviter) {
      try { await notifyReferralSignup(inviter.id, user.name); } catch (error) { request.log.error(error, "referral signup notification failed"); }
    }
    return reply.code(201).send({ user: { id: user.id, name: user.name, email: user.email, roles }, accessToken: signAccessToken(user.id, roles), referralApplied: Boolean(inviter) });
  });

  app.post("/auth/login", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email }, include: { roles: { include: { role: true } } } });
    const passwordOk = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordOk) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    if (user.status === "BLOCKED" || user.status === "SUSPENDED") return reply.code(403).send({ error: "ACCOUNT_RESTRICTED" });
    const roles = user.roles.map((item) => item.role.name);
    await audit({ actorId: user.id, action: "USER_LOGIN", entity: "User", entityId: user.id, ip: request.ip, userAgent: request.headers["user-agent"] });
    return { user: { id: user.id, name: user.name, email: user.email, roles }, accessToken: signAccessToken(user.id, roles) };
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: { id: true, name: true, email: true, phone: true, status: true, roles: { select: { role: { select: { name: true } } } } } });
    if (!user) return reply.code(404).send({ error: "USER_NOT_FOUND" });
    return { ...user, roles: user.roles.map((item) => item.role.name) };
  });
}

import type { FastifyInstance } from "fastify";
import { RoleName, UserStatus } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { audit } from "../services/audit.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users/me", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true } });
    if (!user) return reply.code(404).send({ error: "USER_NOT_FOUND" });
    return user;
  });

  app.patch("/users/me", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(120).optional(), phone: z.string().trim().min(7).max(30).nullable().optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const user = await prisma.user.update({ where: { id: request.auth!.userId }, data: parsed.data });
    await audit({ actorId: user.id, action: "PROFILE_UPDATED", entity: "User", entityId: user.id, ip: request.ip, userAgent: request.headers["user-agent"] });
    return { id: user.id, name: user.name, email: user.email, phone: user.phone };
  });

  app.get("/admin/users", { preHandler: [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)] }, async (request) => {
    const q = z.object({ search: z.string().trim().max(100).optional(), status: z.nativeEnum(UserStatus).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { OR: [
        { name: { contains: q.search, mode: "insensitive" as const } },
        { email: { contains: q.search, mode: "insensitive" as const } },
        { phone: { contains: q.search, mode: "insensitive" as const } }
      ] } : {})
    };
    const [data, total] = await Promise.all([
      prisma.user.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { createdAt: "desc" }, select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true, roles: { select: { role: { select: { name: true } } } } } }),
      prisma.user.count({ where })
    ]);
    return { data, pagination: { page: q.page, limit: q.limit, total } };
  });
}

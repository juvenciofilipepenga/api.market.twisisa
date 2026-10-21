import type { FastifyInstance } from "fastify";
import { RoleName, UserStatus, type AdminProfile } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ADMIN_PROFILES } from "../lib/permissions.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../services/audit.js";

const guard = [requireAuth, requirePermission("team.manage")];
const profilesSchema = z.array(z.enum(ADMIN_PROFILES)).max(ADMIN_PROFILES.length);
const idParams = z.object({ id: z.string().min(1) });

// Equipa de administração: só o SUPER_ADMIN (permissão team.manage) a gere. Um SUPER_ADMIN nunca é alterado por aqui
// (nem promovido, nem despromovido): assim ninguém consegue trancar a conta com todos os poderes por engano.
// Perfis e papéis são lidos da base de dados em cada pedido, por isso retirar um perfil tem efeito imediato.
export async function teamRoutes(app: FastifyInstance): Promise<void> {
  async function loadMember(id: string) {
    return prisma.user.findUnique({ where: { id }, select: { id: true, roles: { select: { role: { select: { name: true } } } } } });
  }

  app.get("/admin/team", { preHandler: guard }, async () => {
    const users = await prisma.user.findMany({
      where: { roles: { some: { role: { name: { in: [RoleName.ADMIN, RoleName.SUPER_ADMIN] } } } } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, status: true, adminProfiles: true, roles: { select: { role: { select: { name: true } } } } }
    });
    const data = users.map((user) => {
      const roles = user.roles.map((item) => item.role.name);
      return { id: user.id, name: user.name, email: user.email, status: user.status, adminProfiles: user.adminProfiles, roles, isSuper: roles.includes(RoleName.SUPER_ADMIN) };
    });
    return { data, profiles: ADMIN_PROFILES };
  });

  // Dá acesso de administração a uma conta que já existe (a pessoa regista-se primeiro como cliente).
  app.post("/admin/team", { preHandler: guard }, async (request, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email(), profiles: profilesSchema }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const target = await prisma.user.findUnique({ where: { email: body.data.email }, select: { id: true, status: true, roles: { select: { role: { select: { name: true } } } } } });
    if (!target) return reply.code(404).send({ error: "USER_NOT_FOUND" });
    if (target.status !== UserStatus.ACTIVE) return reply.code(409).send({ error: "ACCOUNT_RESTRICTED" });
    const roles = target.roles.map((item) => item.role.name);
    if (roles.includes(RoleName.ADMIN) || roles.includes(RoleName.SUPER_ADMIN)) return reply.code(409).send({ error: "ALREADY_ADMIN" });
    const role = await prisma.role.upsert({ where: { name: RoleName.ADMIN }, update: {}, create: { name: RoleName.ADMIN } });
    await prisma.$transaction([
      prisma.userRole.create({ data: { userId: target.id, roleId: role.id } }),
      prisma.user.update({ where: { id: target.id }, data: { adminProfiles: body.data.profiles as AdminProfile[] } })
    ]);
    await audit({ actorId: request.auth!.userId, action: "TEAM_MEMBER_ADDED", entity: "User", entityId: target.id, metadata: { profiles: body.data.profiles } });
    return reply.code(201).send({ id: target.id });
  });

  app.put("/admin/team/:id/profiles", { preHandler: guard }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = z.object({ profiles: profilesSchema }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const target = await loadMember(params.data.id);
    if (!target) return reply.code(404).send({ error: "USER_NOT_FOUND" });
    const roles = target.roles.map((item) => item.role.name);
    if (roles.includes(RoleName.SUPER_ADMIN)) return reply.code(403).send({ error: "FORBIDDEN" });
    if (!roles.includes(RoleName.ADMIN)) return reply.code(409).send({ error: "NOT_ADMIN" });
    await prisma.user.update({ where: { id: target.id }, data: { adminProfiles: body.data.profiles as AdminProfile[] } });
    await audit({ actorId: request.auth!.userId, action: "TEAM_PROFILES_UPDATED", entity: "User", entityId: target.id, metadata: { profiles: body.data.profiles } });
    return { id: target.id, adminProfiles: body.data.profiles };
  });

  app.delete("/admin/team/:id", { preHandler: guard }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const target = await loadMember(params.data.id);
    if (!target) return reply.code(404).send({ error: "USER_NOT_FOUND" });
    const roles = target.roles.map((item) => item.role.name);
    if (roles.includes(RoleName.SUPER_ADMIN)) return reply.code(403).send({ error: "FORBIDDEN" });
    if (!roles.includes(RoleName.ADMIN)) return reply.code(409).send({ error: "NOT_ADMIN" });
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: target.id, role: { name: RoleName.ADMIN } } }),
      prisma.user.update({ where: { id: target.id }, data: { adminProfiles: [] } })
    ]);
    await audit({ actorId: request.auth!.userId, action: "TEAM_MEMBER_REMOVED", entity: "User", entityId: target.id });
    return reply.code(204).send();
  });
}

import type { FastifyReply, FastifyRequest } from "fastify";
import { RoleName } from "../generated/prisma/client.js";
import { verifyAccessToken } from "../lib/auth.js";

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void | FastifyReply> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return reply.code(401).send({ error: "UNAUTHORIZED" });
  try {
    const payload = verifyAccessToken(header.slice(7).trim());
    const roles = payload.roles.filter((role): role is RoleName => Object.values(RoleName).includes(role as RoleName));
    req.auth = { userId: payload.sub, roles };
  } catch {
    return reply.code(401).send({ error: "INVALID_TOKEN" });
  }
}

export function requireRole(...allowed: RoleName[]) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply): Promise<void | FastifyReply> {
    if (!req.auth) return reply.code(401).send({ error: "UNAUTHORIZED" });
    if (!req.auth.roles.some((role) => allowed.includes(role))) return reply.code(403).send({ error: "FORBIDDEN" });
  };
}

export function isAdmin(roles: RoleName[]): boolean {
  return roles.includes(RoleName.ADMIN) || roles.includes(RoleName.SUPER_ADMIN);
}

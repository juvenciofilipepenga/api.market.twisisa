import type { FastifyReply, FastifyRequest } from "fastify";
import { RoleName, UserStatus } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { verifyAccessToken } from "../lib/auth.js";

// O token só prova QUEM é o utilizador. Papéis e estado da conta vêm sempre da base de dados, em cada pedido:
// assim, suspender/bloquear uma conta ou retirar o papel de admin tem efeito imediato, em vez de só
// valer quando o token expirar (15 min). Custo: uma leitura por chave primária por pedido autenticado.
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void | FastifyReply> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return reply.code(401).send({ error: "UNAUTHORIZED" });
  let userId: string;
  try {
    userId = verifyAccessToken(header.slice(7).trim()).sub;
  } catch {
    return reply.code(401).send({ error: "INVALID_TOKEN" });
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, roles: { select: { role: { select: { name: true } } } } }
  });
  if (!user) return reply.code(401).send({ error: "INVALID_TOKEN" });
  if (user.status === UserStatus.BLOCKED || user.status === UserStatus.SUSPENDED) return reply.code(403).send({ error: "ACCOUNT_RESTRICTED" });
  req.auth = { userId, roles: user.roles.map((item) => item.role.name) };
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

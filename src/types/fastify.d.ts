import type { RoleName } from "../generated/prisma/client.js";
import type { Permission } from "../lib/permissions.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: { userId: string; roles: RoleName[]; permissions: Permission[] };
  }
}

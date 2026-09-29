import type { RoleName } from "../generated/prisma/client.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: { userId: string; roles: RoleName[] };
  }
}

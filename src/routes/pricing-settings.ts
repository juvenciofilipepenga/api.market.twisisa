import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RoleName } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getPricingThresholds } from "../services/pricingSettings.js";

const adminOnly = [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)];

const schema = z.object({
  goodFromPct: z.number().min(0).max(1000),
  excellentFromPct: z.number().min(0).max(1000)
}).refine((v) => v.excellentFromPct > v.goodFromPct, { message: "excellent must be above good" });

export async function pricingSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/pricing-settings", { preHandler: adminOnly }, async () => getPricingThresholds());

  app.put("/admin/pricing-settings", { preHandler: adminOnly }, async (request, reply) => {
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    await prisma.pricingSettings.upsert({ where: { id: "main" }, update: body.data, create: { id: "main", ...body.data } });
    await audit({ actorId: request.auth!.userId, action: "PRICING_SETTINGS_UPDATED", entity: "PricingSettings", entityId: "main", metadata: body.data });
    return getPricingThresholds();
  });
}

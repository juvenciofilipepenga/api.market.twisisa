import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RoleName } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getPaymentSettings, onlineStatus } from "../services/paymentSettings.js";

const clean = (v: string) => v.replace(/[\s-]/g, "").replace(/^\+?258/, "");
const phoneOpt = (re: RegExp, msg: string) =>
  z.union([z.literal("").transform(() => null), z.null(), z.string().trim().transform(clean).pipe(z.string().regex(re, msg))]).optional().transform((v) => v ?? null);
const textOpt = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

const schema = z.object({
  onlineEnabled: z.boolean(),
  manualEnabled: z.boolean(),
  mpesaNumber: phoneOpt(/^8[45]\d{7}$/, "Número M-Pesa inválido (84 ou 85 + 7 dígitos)"),
  mpesaName: textOpt(80),
  emolaNumber: phoneOpt(/^8[67]\d{7}$/, "Número e-Mola inválido (86 ou 87 + 7 dígitos)"),
  emolaName: textOpt(80),
  bankName: textOpt(80),
  bankNib: z.union([z.literal("").transform(() => null), z.null(), z.string().trim().regex(/^[0-9 ]{10,30}$/, "NIB inválido")]).optional().transform((v) => v ?? null),
  bankHolder: textOpt(80),
  instructions: textOpt(600)
});

export async function paymentSettingsRoutes(app: FastifyInstance): Promise<void> {
  const admin = { preHandler: [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)] };
  const view = (s: Awaited<ReturnType<typeof getPaymentSettings>>) => ({ ...s, onlineStatus: onlineStatus(s) });

  app.get("/admin/payment-settings", admin, async () => view(await getPaymentSettings()));

  app.put("/admin/payment-settings", admin, async (request, reply) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT", field: parsed.error.issues[0]?.path.join(".") });
    await getPaymentSettings();
    const updated = await prisma.paymentSettings.update({ where: { id: "main" }, data: parsed.data });
    await audit({ actorId: request.auth!.userId, action: "PAYMENT_SETTINGS_UPDATED", entity: "PaymentSettings", entityId: "main", metadata: { onlineEnabled: parsed.data.onlineEnabled, manualEnabled: parsed.data.manualEnabled } }).catch((e) => request.log.error(e, "audit failed"));
    return view(updated);
  });

  // "O ZumboPay já voltou": fecha o disjuntor sem esperar os 10 minutos.
  app.post("/admin/payment-settings/reset-degraded", admin, async (request) => {
    await getPaymentSettings();
    const updated = await prisma.paymentSettings.update({ where: { id: "main" }, data: { zpFailures: 0, zpFailureAt: null, zpDegradedUntil: null } });
    await audit({ actorId: request.auth!.userId, action: "PAYMENT_BREAKER_RESET", entity: "PaymentSettings", entityId: "main", metadata: {} }).catch((e) => request.log.error(e, "audit failed"));
    return view(updated);
  });
}
